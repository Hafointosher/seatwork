import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The setup screen's settings and questions to the plugin; model choices are differences from the room's table, in its own shape. */

const modelChoices = z.record(z.string(), z.json());

export const roomSettings = defineSettings({
  id: "room",
  scope: "host",
  version: 1,
  schema: z.object({
    models: modelChoices.default({}),
    chime: z.boolean().default(true),
  }),
});
export type RoomChoices = z.infer<typeof roomSettings.schema>;

const choices = z.object({ models: modelChoices, chime: z.boolean() });

const harness = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  why: z.string(),
  models: z.array(
    z.object({ id: z.string(), label: z.string(), thinking: z.array(z.string()), defaultThinking: z.string() }),
  ),
});

const project = z.object({
  name: z.string(),
  root: z.string(),
  own: z.boolean(),
  models: modelChoices,
  error: z.string().nullable(),
});

/** What a finished removal reports back through the state: the seats it took out, where the room's folder went, the project notes it carried, and what it could not do. */
const removal = z.object({
  removed: z.array(z.string()),
  movedTo: z.string(),
  projects: z.array(z.object({ root: z.string(), moved: z.array(z.string()), left: z.array(z.string()) })),
  notes: z.array(z.string()),
});

export const setupState = defineRpc({
  name: "setup.state",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    home: z.string(),
    applied: choices.extend({ version: z.string(), seats: z.array(z.string()) }).nullable(),
    table: z.json(),
    harnesses: z.array(harness),
    projects: z.array(project),
    known: z.array(z.object({ name: z.string(), root: z.string() })),
    checks: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
    removing: z.boolean(),
    removed: removal.nullable(),
    removeError: z.string().nullable(),
  }),
});

export const setupInit = defineRpc({
  name: "setup.init",
  input: choices,
  output: z.object({ seats: z.array(z.string()), removed: z.array(z.string()), notes: z.array(z.string()) }),
});

export const setupRemove = defineRpc({
  name: "setup.remove",
  input: z.object({}),
  output: z.object({ started: z.boolean() }),
});

export const setupProject = defineRpc({
  name: "setup.project",
  input: z.object({ name: z.string(), models: modelChoices.nullable() }),
  output: z.object({ own: z.boolean(), seats: z.array(z.string()) }),
});

export const setupProjectAdd = defineRpc({
  name: "setup.project-add",
  input: z.object({
    path: z.string().min(1).max(4096),
    name: z.string().max(256).optional(),
    mission: z.string().max(8192).optional(),
  }),
  output: z.object({ message: z.string() }),
});

export const setupProjectRemove = defineRpc({
  name: "setup.project-remove",
  input: z.object({ name: z.string().max(256) }),
  output: z.object({ message: z.string() }),
});

const jevCheck = z.object({ at: z.string(), ok: z.boolean(), ms: z.number().nullable(), why: z.string().nullable() });

export const jevState = defineRpc({
  name: "jev.state",
  input: z.object({}),
  output: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    key: z.enum(["file", "env", "none", "keyless"]),
    why: z.string().nullable(),
    calls: z.number(),
    failed: z.number(),
    monthUsd: z.number(),
    check: jevCheck.nullable(),
  }),
});

export const jevKey = defineRpc({
  name: "jev.key",
  input: z.object({ key: z.string().min(1).max(512) }),
  output: jevCheck,
});

export const jevTry = defineRpc({
  name: "jev.check",
  input: z.object({}),
  output: jevCheck,
});

const jevPlace = z.object({ id: z.string(), label: z.string(), about: z.string(), on: z.boolean() });
const jevPlaceList = z.object({ required: z.array(jevPlace), optional: z.array(jevPlace) });

export const jevPlaces = defineRpc({ name: "jev.places", input: z.object({}), output: jevPlaceList });

export const jevPlaceSet = defineRpc({
  name: "jev.place",
  input: z.object({ id: z.string().max(64), on: z.boolean() }),
  output: jevPlaceList,
});
