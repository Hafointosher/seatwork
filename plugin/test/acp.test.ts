import { installRoom, PLUGIN_DIR, PROJECT, ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerAcpRequest } from "../server/safety/acp";
import { launch, providerOf } from "../server/room/launch";
import { planRoom } from "../server/paseo/setup/plan";
import { ACP_HARNESSES, parseSeat } from "../server/orchestration/seats";
import { ensureRuntime, envFor, runtimeDir } from "../server/orchestration/runtimes";
import { loadPolicy } from "../server/policy";
import { ROLES } from "../shared/workflow";
import { guardAt, keptRules, machine, PROJECT as TREE, SEAT } from "./support/gate";

/** The ACP harnesses' permission flow: the room answers each request by the same guard the CLI hooks read. */

shipSql();

test("devin and grok are seats of every role, on no runtime home of the room's", () => {
  installRoom(["claude-hq"]);
  for (const role of ROLES)
    for (const harness of ["devin", "grok"] as const) {
      const seat = parseSeat(`${harness}-${role}`);
      assert.ok(seat, `${harness}-${role}`);
      assert.equal(seat.harness, harness);
      assert.equal(seat.role, role);
      assert.ok(ACP_HARNESSES.has(harness));
      assert.equal(ensureRuntime(seat, loadPolicy()), null);
      assert.equal(existsSync(runtimeDir(seat)), false);
      assert.deepEqual(envFor(seat, loadPolicy()), {});
    }
  assert.equal(ACP_HARNESSES.has("claude"), false);
});

test("an ACP seat's provider extends acp itself with its own launch command, since Paseo extends builtins alone", async () => {
  installRoom([]);
  const { providers } = await planRoom({
    pluginDir: PLUGIN_DIR,
    roomHome: ROOM_HOME,
    setup: {},
    catalog: async () => ({}),
  });
  assert.equal(providers["devin-hq"].extends, "acp");
  assert.deepEqual(providers["devin-hq"].command, ["devin", "acp"]);
  assert.equal(providers["grok-hq"].extends, "acp");
  assert.deepEqual(providers["grok-hq"].command, ["grok", "agent", "stdio"]);
  assert.equal(providers["claude-hq"].extends, "claude");
  assert.equal(providers["claude-hq"].command, undefined);
});

test("the room's own seat starts on the provider the table gives its role, not the first one set up", () => {
  installRoom(["claude-hq", "devin-hq"]);
  const table = join(ROOM_HOME, "room", "models.json");
  const models = JSON.parse(readFileSync(table, "utf8"));
  models.seats.hq.provider = "devin-hq/swe-2-high";
  writeFileSync(table, JSON.stringify(models));
  assert.equal(providerOf("hq"), "devin-hq");
});

test("a devin seat starts in the table's accept-edits mode, a grok seat on no mode", async () => {
  installRoom(["devin-peer", "grok-peer"]);
  const devin = await launch(
    { provider: "devin-peer", cwd: PROJECT, title: "[Peer] the cache" },
    loadPolicy(),
    () => {},
  );
  assert.equal(devin.mode, "accept-edits");
  assert.match(devin.systemPrompt, /This runtime: Devin/);
  const grok = await launch({ provider: "grok-peer", cwd: PROJECT, title: "[Peer] the cache" }, loadPolicy(), () => {});
  assert.equal(grok.mode, undefined);
  assert.match(grok.systemPrompt, /This runtime: Grok/);
});

test("a shell request is read as a command and allowed, and one that writes the tree is said so to the council", async () => {
  const { guard, store } = guardAt("acp-shell", machine());
  const read = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r1",
    kind: "tool",
    detail: { type: "shell", command: "ls -la", cwd: TREE },
  });
  assert.deepEqual(read.answer, { allow: true });
  assert.equal(read.wrote, null);
  const write = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r2",
    kind: "tool",
    detail: { type: "shell", command: `rm -rf ${TREE}/build`, cwd: TREE },
  });
  assert.deepEqual(write.answer, { allow: true });
  assert.equal(write.wrote, `rm -rf ${TREE}/build`);
  assert.ok(keptRules(store).includes("delete:seat"), keptRules(store).join(","));
});

test("a command carried only in the request's input is still read as a shell line", async () => {
  const { guard, store } = guardAt("acp-input", machine());
  const answered = await answerAcpRequest(guard, SEAT, "grok", {
    id: "r3",
    kind: "tool",
    name: "bash",
    input: { command: `rm -rf ${TREE}/build` },
  });
  assert.deepEqual(answered.answer, { allow: true });
  assert.equal(answered.wrote, `rm -rf ${TREE}/build`);
  assert.ok(keptRules(store).includes("delete:seat"));
});

test("a read of the owner's keys is kept as such and allowed", async () => {
  const { guard, store } = guardAt("acp-read", machine());
  const answered = await answerAcpRequest(guard, SEAT, "grok", {
    id: "r4",
    kind: "tool",
    detail: { type: "read", filePath: "/Users/u/.ssh/id_rsa" },
  });
  assert.deepEqual(answered.answer, { allow: true });
  assert.ok(keptRules(store).includes("read:credentials"), keptRules(store).join(","));
});

test("a write names its file to the council and is allowed", async () => {
  const { guard } = guardAt("acp-write", machine());
  const answered = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r5",
    kind: "tool",
    detail: { type: "edit", filePath: `${TREE}/src/app.ts`, newString: "x" },
  });
  assert.deepEqual(answered.answer, { allow: true });
  assert.equal(answered.wrote, `write ${TREE}/src/app.ts`);
});

test("a question asked in the harness's own dialog is sent to the room's mail instead", async () => {
  const { guard } = guardAt("acp-ask", machine());
  const answered = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r6",
    kind: "question",
    name: "ask_user",
    input: { question: "which branch?" },
  });
  assert.equal(answered.answer?.allow, false);
  assert.match((answered.answer as { message: string }).message, /seatwork_mail/);
});

test("a mode the harness asks to switch to is refused, so the seat's calls keep reaching the room", async () => {
  const { guard } = guardAt("acp-mode", machine());
  const answered = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r7",
    kind: "mode",
    input: { modeId: "bypass" },
  });
  assert.equal(answered.answer?.allow, false);
  assert.match((answered.answer as { message: string }).message, /session mode/);
});

test("a request the room cannot read is kept as unread and allowed to run", async () => {
  const { guard, store } = guardAt("acp-other", machine());
  const answered = await answerAcpRequest(guard, SEAT, "grok", {
    id: "r8",
    kind: "tool",
    name: "spawn_agent",
    detail: { type: "sub_agent" },
    title: "spawn a helper",
  });
  assert.deepEqual(answered.answer, { allow: true });
  assert.ok(keptRules(store).includes("unread:command"), keptRules(store).join(","));
});

test("a call to one of the room's own tools is allowed without a doubt, since the room's policy sits inside it", async () => {
  const { guard, store } = guardAt("acp-room-tool", machine());
  const answered = await answerAcpRequest(guard, SEAT, "devin", {
    id: "r9",
    kind: "tool",
    name: "seatwork_room",
    detail: { type: "other" },
    title: "room health",
  });
  assert.deepEqual(answered.answer, { allow: true });
  assert.deepEqual(keptRules(store), []);
});
