import { PROJECT } from "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginRoom } from "./support/plugin";
import settings from "../shared/settings.json";

/** The room's cap on open seats: in a file of its own, since filling it takes one agent.created per seat and each notes where it started on git, which no other test should wait behind. */

const { call, agents, context } = pluginRoom(["claude-peer"]);

const created = (id: string) => ({
  agent: { id, parentAgentId: null, provider: "claude-peer", cwd: PROJECT, title: "[Peer] cap", workspaceId: null },
});

const createRequest = () => ({
  request: { config: { provider: "claude-peer", cwd: PROJECT, title: "[Peer] task" }, env: {} },
});

test("a new seat is refused once the room holds the most open seats it may", async () => {
  for (let i = 0; i < settings.openSeatsMost; i += 1) {
    const id = `cap-peer-${i}`;
    agents[id] = { refresh: async () => {}, current: () => ({ status: "idle", provider: "claude-peer" }) };
    await call("on agent.created", created(id), context);
  }
  await assert.rejects(
    async () => call("before agent.create", createRequest(), context),
    /seats of the room are already open/,
  );
});

test("an app that cannot list its agents proves nothing: a seat still starts at the cap", async () => {
  const list = context.paseo.agents.list;
  context.paseo.agents.list = async () => {
    throw new Error("the daemon is down");
  };
  try {
    const made = (await call("before agent.create", createRequest(), context)) as { env: Record<string, string> };
    assert.ok(made.env, "the seat's env comes back: the cap was not read, so it was not enforced");
  } finally {
    context.paseo.agents.list = list;
  }
});
