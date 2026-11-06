import { createHash } from "node:crypto";
import { join } from "node:path";
import { findOnPath, toGatePath } from "../win32";
import type { Guard, SeatRef } from "./guard";
import type { ShellKind } from "./gate/evaluate";

/** The thin hooks each agent CLI runs before a tool call, and the answer each reads; a hook finds the guard by GATE_ENV. */

export type Cli = "claude" | "codex" | "pi" | "opencode";

export const GATE_ENV = {
  url: "SEATWORK_GATE_URL",
  seat: "SEATWORK_GATE_SEAT",
  seconds: "SEATWORK_GATE_SECONDS",
} as const;

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell", "bash", "shell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit"]);
const READ_TOOLS: Record<string, boolean> = {
  read: false,
  grep: true,
  find: false,
  ls: false,
  glob: false,
  list: false,
};
const QUESTION_TOOLS = new Set(["request_user_input", "request_user_input_async"]);
export const ASK_BY_MAIL =
  "Ask in your final message, or by mail with seatwork_mail: a question asked here keeps you in your turn, and nobody in the room sees it.";
const MOVES_TREE =
  "`{command}` moves the tree every seat in this project works in: their uncommitted work moves with it. Unless your brief asked for it, put it back now. The code without a change is in a `seatwork_safety` `control`.";

interface Call {
  shell: string | null;
  kind: ShellKind;
  writes: string[];
  read: { path: string; whole: boolean } | null;
  texts: Map<string, string>;
  cwd: string | null;
  refused: string | null;
}

/** The grammar a tool call's `command` is written in: Codex's shell is PowerShell wherever it runs, OpenCode's is cmd on Windows and sh elsewhere; Claude and Pi name theirs on the call. */
function shellKind(cli: Cli, tool: string): ShellKind {
  if (cli === "codex") return "ps";
  if (cli === "opencode") return process.platform === "win32" ? "cmd" : "sh";
  return tool === "PowerShell" || tool === "powershell" ? "ps" : "sh";
}

const MOST_FILES = 200;
const MOST_PATCH_CHARS = 2 * 1024 * 1024;
const MOST_PATH_CHARS = 4096;

/** The tool call inside a hook's payload: the shell line it runs, or the files it writes; the guard reads only the first files of a large call, the call runs whole. */
function callOf(body: Record<string, unknown>, cli: Cli): Call {
  const input = (body.tool_input ?? body.input ?? {}) as Record<string, unknown>;
  const tool = String(body.tool_name ?? body.tool ?? "");
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const call: Call = { shell: null, kind: "sh", writes: [], read: null, texts: new Map(), cwd, refused: null };
  const patch = tool === "apply_patch" ? input.command : tool === "patch" ? input.patchText : null;
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") {
    call.shell = input.command;
    call.kind = shellKind(cli, tool);
  } else if (typeof patch === "string") patchOf(patch, call);
  else if (QUESTION_TOOLS.has(tool)) call.refused = ASK_BY_MAIL;
  else if (Object.hasOwn(READ_TOOLS, tool)) {
    const path = input.path ?? input.file_path ?? input.filePath ?? ".";
    if (typeof path === "string") call.read = { path, whole: READ_TOOLS[tool] };
  } else if (WRITE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof path === "string") {
      call.writes = [path];
      call.texts.set(path, addedBy(input));
    }
  }
  call.writes = call.writes.filter((path) => path.length <= MOST_PATH_CHARS).slice(0, MOST_FILES);
  return call;
}

/** The text an editing call adds: a file's content, the new string of an edit, of each of several, or of a notebook cell. */
function addedBy(input: Record<string, unknown>): string {
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
  return [input, ...edits]
    .flatMap((part) => [part.content, part.new_string, part.newString, part.newText, part.new_source])
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** The files a patch writes, and the lines it adds to each; a patch past the guard's limits is not read for lines. */
function patchOf(patch: string, call: Call): void {
  call.writes = patchTargets(patch);
  if (call.writes.length > MOST_FILES || patch.length > MOST_PATCH_CHARS) return;
  const added = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      file = (header[1] ?? header[2]).trim();
      if (!added.has(file)) added.set(file, []);
    } else if (line.startsWith("*** ")) file = null;
    else if (file && line.startsWith("+")) added.get(file)!.push(line.slice(1));
  }
  for (const [path, lines] of added) call.texts.set(path, lines.join("\n"));
}

/** The files an apply_patch body adds, updates, deletes or moves to; the reading stops one file past what the guard checks. */
function patchTargets(patch: string): string[] {
  if (patch.length > MOST_PATCH_CHARS) return [];
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    out.add((m[1] ?? m[2]).trim());
    if (out.size > MOST_FILES) break;
  }
  return [...out];
}

/** Reads one hook payload and answers in the shape that CLI reads: a refusal of a question meant for the room's mail, or the notes that ride on the call (a git command that moves the shared tree, then `note`); `wrote` is the shell line that runs and writes the seat's tree, `noted` whether `note` went out. */
export async function answerHook(
  guard: Guard,
  cli: Cli,
  body: Record<string, unknown>,
  seat: SeatRef | null,
  note?: string,
): Promise<{ type: string; text: string; noted: boolean; wrote: string | null }> {
  const call = callOf(body, cli);
  if (call.refused) return { ...render(cli, { refused: call.refused }), noted: false, wrote: null };
  let wrote: string | null = null;
  let moved: string | null = null;
  if (call.shell !== null) {
    const checked = await guard.check(seat, cli, call.shell, call.cwd, call.kind);
    if (checked.writes) wrote = call.shell;
    if (checked.moves) moved = MOVES_TREE.replace("{command}", checked.moves.slice(0, 200));
  }
  if (call.read) {
    const { path, whole } = call.read;
    await guard.checkRead(seat, cli, absolute(path, call.cwd), call.cwd, whole);
  }
  for (const path of call.writes)
    await guard.checkWrite(seat, cli, absolute(path, call.cwd), call.cwd, call.texts.get(path));
  const notes = [moved, note].filter(Boolean).join("\n\n");
  return { ...render(cli, { note: notes || undefined }), noted: Boolean(note), wrote };
}

/** A path as the gate spells it, made absolute on the call's cwd when it is not already. */
export const absolute = (path: string, cwd: string | null) => {
  const spelled = toGatePath(path);
  return spelled.startsWith("/") || !cwd ? spelled : `${toGatePath(cwd).replace(/\/+$/, "")}/${spelled}`;
};

/** An answer in the shape its CLI reads: hook JSON for Claude and Codex, the note alone for Pi and OpenCode, which ask about no tool the room refuses. */
export function render(cli: Cli, answer: { refused?: string; note?: string }): { type: string; text: string } {
  if (cli === "pi" || cli === "opencode")
    return answer.note
      ? { type: "application/json", text: JSON.stringify({ note: answer.note }) }
      : { type: "text/plain", text: "" };
  if (!answer.refused && !answer.note) return { type: "text/plain", text: "" };
  const output = answer.refused
    ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.refused }
    : { hookEventName: "PreToolUse", additionalContext: answer.note };
  return { type: "application/json", text: JSON.stringify({ hookSpecificOutput: output }) };
}

const ASK_SECONDS = 4;
const RETRY_SECONDS = 3;

/** The Node a hook's command names: one on PATH where there is one, else the binary the daemon runs on. */
const hookNode = () => findOnPath("node") ?? process.execPath;

/** The file name the gate hook is laid down under, next to a runtime's hooks.json or a Claude plugin's hooks/. */
export const GUARD_FILE = "room-guard.mjs";

/** The hook script Claude and Codex run: it hands the payload to the room and prints the answer; with no answer the call runs. */
export function guardScript(): string {
  return `// The room's hook: tells the room of this tool call and prints its answer.
const url = process.env.${GATE_ENV.url};
if (!url) process.exit(0);
const cli = process.argv[2] ?? "";
const input = await new Promise((done) => {
  let text = "";
  process.stdin.setEncoding("utf8").on("data", (piece) => (text += piece)).on("end", () => done(text));
});
const deadline = Date.now() + ${RETRY_SECONDS * 1000};
for (;;) {
  try {
    const res = await fetch(\`\${url}?cli=\${cli}\`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat": process.env.${GATE_ENV.seat} ?? "" },
      body: input,
      signal: AbortSignal.timeout(Number(process.env.${GATE_ENV.seconds} ?? ${ASK_SECONDS}) * 1000),
    });
    if (res.ok) process.stdout.write(await res.text());
    break;
  } catch {
    if (Date.now() >= deadline) break;
    await new Promise((wait) => setTimeout(wait, 700));
  }
}
`;
}

export const SKILLS_ENV = "ROOM_SKILLS_DIR";

/** Prints the name and description of each skill in the seat's folder: after a compaction Claude Code has dropped its own list. */
export function skillsScript(): string {
  return `// The seat's skills, told again after a compaction.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.${SKILLS_ENV};
if (!dir) process.exit(0);
let entries = [];
try {
  entries = readdirSync(dir, { withFileTypes: true });
} catch {
  process.exit(0);
}
console.log("After the compaction, your skills, each loaded by the Skill tool when its moment comes:");
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  try {
    const text = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
    const name = /^name:[ \\t]*(.*)$/m.exec(text)?.[1]?.trim();
    const about = /^description:[ \\t]*(.*)$/m.exec(text)?.[1]?.trim().replace(/^"|"$/g, "");
    if (name) console.log(\`- \${name}: \${about ?? ""}\`);
  } catch {}
}
`;
}

/** A Claude plugin folder at `dir`, loaded with --plugin-dir: its manifest, its PreToolUse hook run straight under Node, and its skills told again after a compaction. */
export function claudePlugin(dir: string): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": `${JSON.stringify({ name: "room-guard", description: "The room's hook: every shell command and file write is told to the room first." }, null, 2)}\n`,
    [`hooks/${GUARD_FILE}`]: guardScript(),
    [`hooks/${SKILLS_FILE}`]: skillsScript(),
    "hooks/hooks.json": `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Monitor|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
              hooks: [
                {
                  type: "command",
                  command: hookNode(),
                  args: [join(dir, "hooks", GUARD_FILE), "claude"],
                  timeout: 10,
                },
              ],
            },
          ],
          SessionStart: [
            {
              matcher: "compact",
              hooks: [{ type: "command", command: hookNode(), args: [join(dir, "hooks", SKILLS_FILE)], timeout: 10 }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  };
}

const SKILLS_FILE = "room-skills.mjs";
const CODEX_MATCHER = "^(Bash|apply_patch|request_user_input|request_user_input_async)$";
const CODEX_TIMEOUT = 10;

/** The line Codex's shell runs for the hook at `dir`: one spelling the platform's shell reads — sh on POSIX, the call operator on Windows's PowerShell. */
const codexCommand = (dir: string) =>
  process.platform === "win32"
    ? `& '${hookNode()}' '${join(dir, GUARD_FILE)}' codex`
    : `'${hookNode()}' '${join(dir, GUARD_FILE)}' codex`;

/** Codex's hooks.json for a seat's home at `dir`; its gate script is laid down beside it. */
export function codexHooks(dir: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: CODEX_MATCHER,
            hooks: [{ type: "command", command: codexCommand(dir), timeout: CODEX_TIMEOUT }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/** The trust Codex keeps for a hook it runs without review: its key and definition hash. */
export function codexTrust(hooksFile: string, dir: string): { key: string; hash: string } {
  const identity = {
    event_name: "pre_tool_use",
    hooks: [{ async: false, command: codexCommand(dir), timeout: CODEX_TIMEOUT, type: "command" }],
    matcher: CODEX_MATCHER,
  };
  const hash = createHash("sha256").update(canonical(identity)).digest("hex");
  return { key: `${hooksFile}:pre_tool_use:0:0`, hash: `sha256:${hash}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The call Pi's extension and OpenCode's plugin make: the room's answer, or null when none comes. */
function askRoom(cli: Cli): string {
  return `async function ask(body: unknown): Promise<any> {
  const url = process.env.${GATE_ENV.url};
  if (!url) return null;
  for (const until = Date.now() + ${RETRY_SECONDS * 1000}; ; ) {
    try {
      const res = await fetch(url + "?cli=${cli}", {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat": process.env.${GATE_ENV.seat} ?? "" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(${ASK_SECONDS * 1000}),
      });
      return res.ok ? await res.json().catch(() => null) : null;
    } catch (error: any) {
      if (error?.name === "TimeoutError" || Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}`;
}

/** Pi's extension: every bash, write, edit and read call is told to the room first, and what the room says rides on the call's result. */
export function piExtension(): string {
  return `// The room's hook: every bash, write, edit and read call is told to the room first; what it says rides on the call's result.
${askRoom("pi")}

let notes: string[] = [];
export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["bash", "write", "edit", "read", "grep", "find", "ls"].includes(event.toolName)) return;
    const answer = await ask({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
    if (typeof answer?.note === "string") notes.push(answer.note);
  });
  pi.on("tool_result", async (event: any) => {
    if (notes.length === 0) return;
    const text = notes.join("\\n\\n");
    notes = [];
    return { content: [...event.content, { type: "text", text }], structuredContent: event.structuredContent };
  });
}
`;
}

/** OpenCode's V2 plugin: every shell, write, edit, patch and read call is told to the room first, and what the room says rides on the call's result. */
export function openCodePlugin(): string {
  return `// The room's hook: every shell, write, edit, patch and read call is told to the room first; what it says rides on the call's result.
${askRoom("opencode")}

let notes: string[] = [];
export default {
  id: "room-guard",
  setup(ctx: any) {
    ctx.tool.hook("execute.before", async (e: any) => {
      if (!["shell", "write", "edit", "patch", "read", "grep", "glob", "list"].includes(e.tool)) return;
      const answer = await ask({ tool: e.tool, input: e.input, cwd: ctx.location?.directory ?? null });
      if (typeof answer?.note === "string") notes.push(answer.note);
    });
    ctx.tool.hook("execute.after", async (e: any) => {
      if (notes.length === 0 || e.status !== "completed" || !e.result) return;
      const text = notes.join("\\n\\n");
      notes = [];
      if (typeof e.result.output === "string") e.result.output += "\\n\\n" + text;
      else if (Array.isArray(e.result.content)) e.result.content.push({ type: "text", text });
    });
  },
};
`;
}
