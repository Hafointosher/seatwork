import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { execProgram, exeSpellings, IS_WINDOWS } from "../win32";

/** The paseo CLI, for daemon operations the plugin SDK lacks; SEATWORK_PASEO_BIN overrides the lookup. */
function paseoBin(): string {
  const names = IS_WINDOWS ? exeSpellings("paseo") : ["paseo"];
  const fixed = ["/opt/homebrew/bin/paseo", "/usr/local/bin/paseo"];
  const candidates: string[] = [];
  if (process.env.SEATWORK_PASEO_BIN) candidates.push(process.env.SEATWORK_PASEO_BIN);
  for (const dir of (process.env.PATH ?? "").split(delimiter))
    for (const name of names) candidates.push(join(dir, name));
  candidates.push(...fixed);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("paseo CLI not found on PATH; set SEATWORK_PASEO_BIN");
}

/** Runs `paseo <args>` and resolves its stdout; rejects with stderr on failure. */
export function paseoCli(args: string[]): Promise<string> {
  const bin = paseoBin();
  return new Promise((resolve, reject) => {
    if (/\.(cmd|bat|ps1|mjs|cjs|js)$/i.test(bin)) {
      void execProgram(bin, args, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }).then(({ code, out, err }) => {
        if (code !== 0) reject(new Error(`paseo ${args.join(" ")}: ${err.trim() || `exit ${code}`}`));
        else resolve(out);
      });
      return;
    }
    execFile(bin, args, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`paseo ${args.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
