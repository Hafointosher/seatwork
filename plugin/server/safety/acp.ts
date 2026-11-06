import type { Guard, SeatRef } from "./guard";
import type { ShellKind } from "./gate/evaluate";
import { absolute, ASK_BY_MAIL } from "./hooks";

/** The ACP harnesses' permission flow: no hook file can be laid in them, so the room reads each permission request the agent emits and answers it itself, by the same guard the CLI hooks read. */

/** A Paseo agent's permission request, as `agent.permission_requested` hands it over (agent-types' AgentPermissionRequest); only the fields the room reads. */
export interface AcpRequest {
  id?: string;
  name?: string;
  kind?: string;
  title?: string;
  input?: Record<string, unknown>;
  detail?: {
    type?: string;
    command?: string;
    cwd?: string;
    filePath?: string;
    content?: string;
    oldString?: string;
    newString?: string;
    unifiedDiff?: string;
    filePaths?: string[];
  } | null;
}

/** The room's answer to one request; null leaves it for the seat's Owner to answer by mail. */
export type AcpAnswer = { allow: true } | { allow: false; message: string } | null;

const KEEP_MODE =
  "Stay in your session mode: the room reads your calls through it. If the mode blocks work you were asked to do, say so in your final message or by mail.";

const MOST_READ_PATHS = 8;

/** One ACP permission request, read by the guard and answered in the room's own words; `wrote` is the shell line or file path that runs and writes, for the council's reading of the turn. */
export async function answerAcpRequest(
  guard: Guard,
  seat: SeatRef | null,
  cli: string,
  request: AcpRequest,
): Promise<{ answer: AcpAnswer; wrote: string | null }> {
  // a question asked in the harness's own dialog keeps the seat in its turn with nobody told; a mode change would hide the seat's calls from the room
  if (request.kind === "question") return { answer: { allow: false, message: ASK_BY_MAIL }, wrote: null };
  if (request.kind === "mode") return { answer: { allow: false, message: KEEP_MODE }, wrote: null };
  const detail = request.detail ?? {};
  const cwd = typeof detail.cwd === "string" ? detail.cwd : (seat?.start ?? null);
  const input = request.input ?? {};
  const type = typeof detail.type === "string" ? detail.type : null;
  const command =
    typeof detail.command === "string"
      ? detail.command
      : type === null && typeof input.command === "string"
        ? input.command
        : null;
  if (command !== null) {
    // the request may name its own shell; anything else is read as sh, the ACP agents' usual grammar
    const hint = String(input.shell ?? input.shellKind ?? input.program ?? "").toLowerCase();
    const kind: ShellKind = /pwsh|powershell/.test(hint) ? "ps" : /(^|[^a-z])cmd/.test(hint) ? "cmd" : "sh";
    const checked = await guard.check(seat, cli, command, cwd, kind);
    return { answer: { allow: true }, wrote: checked.writes ? command : null };
  }
  const file =
    typeof detail.filePath === "string"
      ? detail.filePath
      : type === null && typeof (input.file_path ?? input.filePath ?? input.path) === "string"
        ? String(input.file_path ?? input.filePath ?? input.path)
        : null;
  if (type === "read" || (file !== null && type === null && !/write|edit|patch|create/i.test(request.name ?? ""))) {
    if (file !== null) await guard.checkRead(seat, cli, absolute(file, cwd), cwd, false);
    return { answer: { allow: true }, wrote: null };
  }
  if (type === "write" || type === "edit" || file !== null) {
    if (file !== null) {
      await guard.checkWrite(
        seat,
        cli,
        absolute(file, cwd),
        cwd,
        detail.content ?? detail.newString ?? detail.unifiedDiff,
      );
      return { answer: { allow: true }, wrote: `write ${file}` };
    }
    return { answer: { allow: true }, wrote: null };
  }
  if (type === "search") {
    for (const path of (detail.filePaths ?? []).slice(0, MOST_READ_PATHS))
      await guard.checkRead(seat, cli, absolute(path, cwd), cwd, false);
    return { answer: { allow: true }, wrote: null };
  }
  // the room's own tools are the seat's instruments: the room's policy already sits inside them, and they record their own calls — doubting each one would drown the council's doubt list
  if (/seatwork_/i.test(request.name ?? "")) return { answer: { allow: true }, wrote: null };
  // plan, fetch, sub_agent, worktree_setup, plain_text and anything not shaped yet: kept as unread, allowed to run
  await guard.checkOther(
    seat,
    cli,
    `${request.name ?? "permission"}${type ? ` (${type})` : ""}: ${request.title ?? request.kind ?? ""}`,
    cwd,
  );
  return { answer: { allow: true }, wrote: null };
}
