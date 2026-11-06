/** Test room support: the throwaway homes test/isolate.cjs made for this process (a run without it would reach the real ones), and the plugin folder whose room files and policy ship into them. */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { PaseoHost } from "../../server/paseo/host";

const base = process.env.SEATWORK_TEST_BASE;
if (!base) throw new Error("run the tests with npm test: test/isolate.cjs gives them homes of their own");

export const ROOM_HOME = join(base, "room-home");
export const USER_CODEX = join(base, "codex");
export const USER_PI = join(base, "pi");
export const PROJECT = join(base, "project");
export const USER_HOME = join(base, "home");

export const PLUGIN_DIR = join(__dirname, "..", "..");

/** Puts the stores' layout scripts where a store looks for them: they ship with the room files. */
export function shipSql(): void {
  cpSync(join(PLUGIN_DIR, "room", "sql"), join(ROOM_HOME, "room", "sql"), { recursive: true });
}

/** A room home as setting the room up leaves it: the room files, the policy and the enabled seats. */
export function installRoom(providers: string[]): void {
  cpSync(join(PLUGIN_DIR, "room"), join(ROOM_HOME, "room"), { recursive: true });
  const policy = JSON.parse(readFileSync(join(PLUGIN_DIR, "paseo", "policy.json"), "utf8"));
  policy.mail.port = 0; // any free port
  writeFileSync(join(ROOM_HOME, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(ROOM_HOME, "seats.json"), JSON.stringify({ providers, source: PLUGIN_DIR }));
  // set up by the plugin version under test: a room from another version is asked to apply again first
  writeFileSync(
    join(ROOM_HOME, "setup.json"),
    JSON.stringify({ version: JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version }),
  );
}

/** The room's Host over a stand-in Paseo client. */
export function hostOf(paseo: unknown): PaseoHost {
  const host = new PaseoHost();
  host.use(paseo as never);
  return host;
}

/** Whether `path` grants nobody but the owner, SYSTEM, Administrators and owner rights — what `mode & 0o077 === 0` is on POSIX. On Windows the check reads the ACL through icacls, since stat's mode is made-up there. */
export function aclPrivate(path: string): boolean {
  if (process.platform !== "win32") return (statSync(path).mode & 0o077) === 0;
  const allowed = new Set([
    "nt authority\\system",
    "builtin\\administrators",
    "nt authority\\owner rights",
    "owner rights",
    "s-1-3-4",
    "s-1-5-18",
    "s-1-5-32-544",
    userInfo().username.toLowerCase(),
  ]);
  return execFileSync("icacls", [path], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(":("))
    .map((line) => (line.toLowerCase().startsWith(path.toLowerCase()) ? line.slice(path.length).trim() : line))
    .every((line) => {
      const who = line.slice(0, line.indexOf(":(")).trim().toLowerCase();
      return allowed.has(who) || allowed.has(who.split("\\").at(-1)!);
    });
}

export const MAIL_POLICY = {
  port: 0,
  holdFyiWhileRunning: true,
  gatherReviews: true,
  midTurn: { claude: "hold", codex: "hold", pi: "hold", opencode: "hold", devin: "hold", grok: "hold" },
} as const;

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
