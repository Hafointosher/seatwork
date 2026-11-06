// Gives each test process throwaway homes before any module loads: server/paths.ts reads them as it loads.
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const base = mkdtempSync(join(tmpdir(), "seatwork-test-"));
process.on("exit", () => {
  try {
    // open stores hold their files on Windows: close them before the sweep, then clean
    require("../server/sqlite").closeAllStores?.();
  } catch {}
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
});
for (const dir of ["room-home", "codex", "pi", "project", "home"]) mkdirSync(join(base, dir));
// a paseo CLI that moves a label and fails at anything else, run under Node on every platform
const cli = join(base, "paseo-stub.mjs");
writeFileSync(cli, 'process.exit(process.argv[2] === "agent" && process.argv[3] === "update" ? 0 : 1)\n');
chmodSync(cli, 0o755);

Object.assign(process.env, {
  SEATWORK_TEST_BASE: base,
  HOME: join(base, "home"),
  SEATWORK_ROOM_HOME: join(base, "room-home"),
  SEATWORK_PASEO_BIN: cli,
  PASEO_HOME: join(base, "paseo-home"),
  CODEX_HOME: join(base, "codex"),
  CLAUDE_CONFIG_DIR: join(base, "claude"),
  PI_CODING_AGENT_DIR: join(base, "pi"),
  OPENCODE_CONFIG_DIR: join(base, "opencode"),
});
