import { execFile, execFileSync, type ExecFileOptions } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, linkSync, renameSync, statSync, symlinkSync } from "node:fs";
import { devNull, userInfo } from "node:os";
import { delimiter, isAbsolute as winAbsolute, join, resolve as winResolve, win32 } from "node:path";

/** Windows portability: executable lookup with PATHEXT, /c/-form paths for the gate, link primitives that need no privilege. */

export const IS_WINDOWS = process.platform === "win32";
/** The name a program reads as the empty file: `NUL` is what git and cmd open on Windows; `os.devNull` spells it `\\.\nul`, which git cannot. */
export const DEV_NULL = IS_WINDOWS ? "NUL" : devNull;

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const DRIVE = /^[a-zA-Z]:[\\/]/;
const MSYS_DRIVE = /^\/[a-zA-Z](?:\/|$)/;

/** The spellings of `name` PATH lookup tries: the name as spelled, then each PATHEXT suffix it lacks. */
export function exeSpellings(name: string, pathExt?: string): string[] {
  const exts = (pathExt ?? process.env.PATHEXT ?? DEFAULT_PATHEXT.join(";")).split(";").filter(Boolean);
  if (exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) return [name];
  return [name, ...exts.map((ext) => `${name}${ext.toLowerCase()}`)];
}

/** The full path of a program on PATH, PATHEXT-aware; null when no spelling exists. */
export function findOnPath(name: string, pathEnv?: string): string | null {
  const spellings = IS_WINDOWS ? exeSpellings(name, pathEnv !== undefined ? process.env.PATHEXT : undefined) : [name];
  for (const dir of (pathEnv ?? process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const spelling of spellings) {
      const candidate = join(dir, spelling);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/** A Windows path in the gate's POSIX form: `C:\x` and `C:/x` become `/c/x`, `\\srv\sh` becomes `//srv/sh`; other spellings pass through. On POSIX every spelling is already the gate's form. */
export function toGatePath(path: string): string {
  if (!IS_WINDOWS) return path;
  const unc = path.match(/^[/\\]{2,}([^/\\]+)[/\\]([^/\\]+)(.*)$/);
  if (unc) {
    const rest = unc[3].replace(/\\/g, "/");
    return `//${unc[1]}/${unc[2]}${rest}`;
  }
  const drive = DRIVE.exec(path);
  if (drive) return `/${path[0].toLowerCase()}${path.slice(2).replace(/\\/g, "/")}`;
  return path;
}

/** The OS path of a gate path: `/c/x` becomes `C:\x` and `//srv/sh` `\\srv\sh` on Windows; elsewhere the path itself. */
export function fromGatePath(path: string): string {
  if (!IS_WINDOWS) return path;
  const unc = /^\/\/([^/]+)\/(.*)$/.exec(path);
  if (unc) return `\\\\${unc[1]}\\${unc[2].replace(/\//g, "\\")}`;
  if (MSYS_DRIVE.test(path)) return `${path[1].toUpperCase()}:${path.slice(2).replace(/\//g, "\\")}`;
  return path;
}

/** Whether a spelled path is absolute on this platform: POSIX `/`, drive `C:\`, or UNC `\\`. */
export function pathIsAbsolute(path: string): boolean {
  return IS_WINDOWS ? path.startsWith("/") || DRIVE.test(path) || path.startsWith("\\\\") : path.startsWith("/");
}

/** The gate path `spelled` names read from `cwd`, or null when it cannot be told; relative paths join the cwd, absolute spellings keep their form. */
export function resolveGatePath(spelled: string, cwd: string | null): string | null {
  const converted = toGatePath(spelled);
  if (converted.startsWith("/")) return converted;
  return cwd ? `${cwd.replace(/\/+$/, "")}/${converted}` : null;
}

/** Links or mirrors `target` at `link`: symlink on POSIX; on Windows a junction for folders, a hard link for files, a copy when the link cannot be made. */
export function shareEntry(target: string, link: string): void {
  if (!IS_WINDOWS) {
    symlinkSync(target, link);
    return;
  }
  const dir = statSync(target).isDirectory();
  if (dir) {
    try {
      symlinkSync(target, link, "junction");
      return;
    } catch {}
  } else {
    try {
      linkSync(target, link);
      return;
    } catch {}
  }
  copyFileSync(target, link);
}

/** The names an owner-only ACL may hold beyond the owner: SYSTEM and Administrators, as POSIX root always passes. */
const KEEP_ACES = new Set([
  "nt authority\\system",
  "builtin\\administrators",
  "nt authority\\owner rights",
  "owner rights",
  "s-1-3-4",
  "s-1-5-18",
  "s-1-5-32-544",
]);

let ownSid: string | null = null;
/** The caller's SID, which icacls wants for a grant: a name with a space in it reads as more than one argument. */
function sidOf(): string | null {
  if (ownSid !== null) return ownSid;
  try {
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
    const sid = /"?(S-1-[\d-]+)"?/.exec(out)?.[1];
    return (ownSid = sid ?? "");
  } catch {
    return (ownSid = "");
  }
}

/** What `chmod 700` is on Windows: mode bits do not apply, so the entry drops every grant but the owner's, SYSTEM's and Administrators'. Strip and grant go in one call so a bad argument leaves the ACL untouched rather than empty. */
export function privateEntry(path: string, mode = 0o700): void {
  if (!IS_WINDOWS) {
    chmodSync(path, mode);
    return;
  }
  try {
    const self = userInfo().username.toLowerCase();
    const sid = sidOf();
    const listed = execFileSync("icacls", [path], { encoding: "utf8" });
    const foreign = listed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(":("))
      .map((line) => (line.toLowerCase().startsWith(path.toLowerCase()) ? line.slice(path.length).trim() : line))
      // /remove:g touches grants of the entry's own only; what came down the tree, /inheritance:r drops below
      .filter((line) => !line.includes("(I)"))
      .map((line) => line.slice(0, line.indexOf(":(")).trim())
      .filter((name) => {
        const lower = name.toLowerCase();
        return (
          !KEEP_ACES.has(lower) && lower !== self && lower !== (sid ?? "").toLowerCase() && !lower.endsWith(`\\${self}`)
        );
      })
      .map((name) => (name.startsWith("S-") ? `*${name}` : name));
    for (const name of foreign)
      try {
        execFileSync("icacls", [path, "/remove:g", name], { stdio: "ignore" });
      } catch {}
    // (OI)(CI) marks an ACE for the children only: on a file the grant would leave its own list empty
    const perm = statSync(path).isDirectory() ? "(OI)(CI)F" : "F";
    execFileSync(
      "icacls",
      [
        path,
        "/inheritance:r",
        "/grant:r",
        `*S-1-3-4:${perm}`,
        `*S-1-5-18:${perm}`,
        `*S-1-5-32-544:${perm}`,
        ...(sid ? [`*${sid}:${perm}`] : []),
      ],
      { stdio: "ignore" },
    );
  } catch {
    // no icacls, no ACL: the entry keeps what it inherited, which is still better than failing to write it
  }
}

/** `renameSync` that survives Windows transient EPERM/EBUSY from a scanner holding a freshly written file; gives up after ~2s. */
export function moveRename(from: string, to: string): void {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (i >= 20 || !code || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
      Atomics.wait(nap, 0, 0, 100);
    }
  }
}

/** Whether `link` is an entry `shareEntry` may have made for `target`: a symlink/junction, or a hard link to it. */
export function sharesEntry(link: string, target: string): boolean {
  try {
    if (lstatSync(link).isSymbolicLink()) return true;
    const a = statSync(link);
    const b = statSync(target);
    return a.isFile() && b.isFile() && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Runs a program file Windows cannot exec directly (.cmd/.bat via cmd, .ps1 via pwsh/powershell); anything else straight. */
export function execProgram(
  bin: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ code: number; out: string; err: string }> {
  const lower = bin.toLowerCase();
  let file = bin;
  let argv: readonly string[] = args;
  if (IS_WINDOWS && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = process.env.ComSpec || "cmd.exe";
    argv = [
      "/d",
      "/s",
      "/c",
      `"${bin}"`,
      ...args.map((a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)),
    ];
    return execAs(comspec, argv, options);
  }
  if (IS_WINDOWS && lower.endsWith(".ps1")) {
    const shell = findOnPath("pwsh") ?? findOnPath("powershell") ?? "powershell.exe";
    argv = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bin, ...args];
    return execAs(shell, argv, options);
  }
  if (/\.(mjs|cjs|js)$/.test(lower)) return execAs(process.execPath, [bin, ...args], options);
  return execAs(file, argv, options);
}

function execAs(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    execFile(file, [...args], { encoding: "utf8", windowsHide: true, ...options }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolvePromise({
        code: !error ? 0 : typeof code === "number" ? code : -1,
        out: typeof stdout === "string" ? stdout : (stdout?.toString("utf8") ?? ""),
        err: typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? ""),
      });
    });
  });
}

/** Native absolute resolve for a word that may spell a Windows path: drive and UNC forms win32 understands. */
export function winResolvePath(word: string, cwd: string | null): string | null {
  if (winAbsolute(word) || word.includes("/") || word.includes("\\"))
    return cwd ? winResolve(cwd, word) : IS_WINDOWS ? winResolve(word) : null;
  return null;
}
