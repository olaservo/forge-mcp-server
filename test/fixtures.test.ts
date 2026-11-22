import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import * as out from "../src/schemas.js";
import { avatarSheet, connect, fakeBridge } from "./helpers.js";

/** Real bridge payloads, recorded by forge-agent-bridge's tests (`BridgeHttp.saveFixtures`) while a draft and a match ran in-process. The rigged, scry, surveil, reveal, combat, phasing, attached, target and nextgame recordings come from its one-situation tests. */
const dir = new URL("./fixtures/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8")) as Record<string, string>;
const fixture = (file: string) => JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, unknown>;

const schemaForRoute: Record<string, z.ZodType> = {
  "GET /status": out.Status,
  "GET /wait": out.Status,
  "POST /connect": out.Status,
  "POST /disconnect": out.Status,
  "POST /lobby/ready": out.Lobby,
  "POST /lobby/avatar": out.Lobby,
  "POST /lobby/name": out.Lobby,
  "POST /lobby/deck": out.DeckResult,
  "POST /chat": out.OkResult,
  "GET /draft/pack": out.Draft,
  "POST /draft/pick": out.PickResult,
  "GET /draft/pool": out.Pool,
  "POST /draft/deck": out.BuiltDeck,
  "GET /game": out.Game,
  "GET /game/log": out.LogResult,
  "POST /game/act": out.Game,
  "POST /game/decide": out.Game,
};

/** "game GET /game#decision" -> route "GET /game". */
const routeOf = (key: string) => key.split(" ").slice(1).join(" ").split("#")[0];

type Fields = Map<string, Set<string>>;
const exported = new Map<unknown, string>(Object.entries(out).map(([name, schema]) => [schema, name]));

/** The schema inside `nullish()`. */
function inner(schema: z.ZodType): z.ZodType {
  let s = schema as z.ZodType & { unwrap?: () => z.ZodType };
  while ((s.def.type === "optional" || s.def.type === "nullable") && s.unwrap) s = s.unwrap();
  return s;
}

/**
 * Walks a payload beside its schema. `seen` gets the fields the payload has and `declared` the fields the schema
 * has, both by object schema. `unknown` gets the payload's fields that the schema does not name.
 */
function walk(schema: z.ZodType, value: unknown, name: string, declared: Fields, seen: Fields, unknown: Set<string>): void {
  const s = inner(schema);
  if (s.def.type === "union") {
    // A text or an object, by bridge version: the object is the form to compare.
    const object = ((s as z.ZodUnion).options as z.ZodType[]).find((o) => o.def.type === "object");
    if (object && typeof value !== "string") walk(object, value, name, declared, seen, unknown);
  } else if (s.def.type === "array") {
    const element = (s as z.ZodArray).element as z.ZodType;
    for (const item of Array.isArray(value) ? value : [undefined]) walk(element, item, name, declared, seen, unknown);
  } else if (s.def.type === "object") {
    const shape = (s as z.ZodObject).shape as Record<string, z.ZodType>;
    const label = exported.get(s) ?? name;
    const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (!declared.has(label)) declared.set(label, new Set(Object.keys(shape)));
    if (!seen.has(label)) seen.set(label, new Set());
    for (const key of Object.keys(record)) {
      if (key in shape) seen.get(label)!.add(key);
      else unknown.add(`${label}.${key}`);
    }
    for (const [key, field] of Object.entries(shape)) walk(field, record[key], `${label}.${key}`, declared, seen, unknown);
  }
}

describe("bridge fixtures", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("name the same fields as the output schemas", () => {
    const declared: Fields = new Map();
    const seen: Fields = new Map();
    const unknown = new Set<string>();
    for (const [key, file] of Object.entries(index)) walk(schemaForRoute[routeOf(key)], fixture(file), routeOf(key), declared, seen, unknown);
    const missing = [...declared].flatMap(([label, keys]) => [...keys].filter((k) => !seen.get(label)!.has(k)).map((k) => `${label}.${k}`));
    // A field the bridge sends and no schema names: add it to the schema.
    expect([...unknown].sort()).toEqual([]);
    // A field a schema names and no recording has: the bridge dropped or renamed it, or no test records it.
    expect(missing.sort()).toEqual([]);
  });

  it("cover every route the tools call", () => {
    const routes = new Set(Object.keys(index).map(routeOf));
    expect([...Object.keys(schemaForRoute)].filter((r) => !routes.has(r))).toEqual([]);
  });

  for (const [key, file] of Object.entries(index)) {
    it(`${key} matches its output schema`, () => {
      const schema = schemaForRoute[routeOf(key)];
      expect(schema, `no schema for ${routeOf(key)}`).toBeDefined();
      const result = schema.safeParse(fixture(file));
      expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    });
  }

  it("every tool runs end to end over the recorded payloads", async () => {
    // Prefer the match recordings, fall back to the draft ones.
    const responses: Record<string, unknown> = {};
    for (const [key, file] of Object.entries(index)) {
      const route = routeOf(key);
      if (key.startsWith("game ") || !(route in responses)) responses[route] = fixture(file);
    }
    vi.stubEnv("FORGE_AVATARS", avatarSheet(3, 2));
    const { bridge, calls } = fakeBridge(responses);
    const client = await connect(bridge);
    // Each tool's arguments and the bridge route it must call. Null for a tool that works without the bridge.
    const cases: Record<string, [Record<string, unknown>, string | null]> = {
      forge_status: [{}, "GET /status"],
      forge_connect: [{ host: "127.0.0.1", port: 36743, name: "Agent" }, "POST /connect"],
      forge_disconnect: [{}, "POST /disconnect"],
      forge_lobby_ready: [{ ready: true }, "POST /lobby/ready"],
      forge_lobby_avatar: [{ index: 3 }, "POST /lobby/avatar"],
      forge_lobby_name: [{ name: "Sarge" }, "POST /lobby/name"],
      forge_name_ideas: [{ type: "Wizard", count: 3 }, null],
      forge_lobby_avatars: [{ page: 0 }, null],
      forge_lobby_deck: [{ dck: "[Main]\n40 Plains" }, "POST /lobby/deck"],
      forge_decks: [{}, null],
      forge_deck_save: [{ text: "4 Lightning Bolt\n20 Mountain", name: "Burn", dryRun: true }, null],
      forge_deck_search: [{ query: "burn" }, null],
      forge_chat: [{ text: "hi" }, "POST /chat"],
      forge_draft_pack: [{}, "GET /draft/pack"],
      forge_draft_pick: [{ card: "0" }, "POST /draft/pick"],
      forge_draft_pool: [{}, "GET /draft/pool"],
      forge_draft_deck: [{ main: ["Doom Blade"], lands: { Swamp: 17 } }, "POST /draft/deck"],
      forge_game_state: [{}, "GET /game"],
      forge_game_log: [{ since: 0 }, "GET /game/log"],
      forge_game_act: [{ action: "ok" }, "POST /game/act"],
      forge_game_decide: [{ id: 1, choices: [0] }, "POST /game/decide"],
      forge_wait: [{ since: 3, timeout: 5 }, "GET /wait"],
      forge_host: [{ port: 36750 }, null],
      forge_host_stop: [{}, null],
    };
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(cases).sort());
    for (const tool of tools) {
      const [args, route] = cases[tool.name];
      const before = calls.length;
      const res = await client.callTool({ name: tool.name, arguments: args });
      expect(res.isError, `${tool.name}: ${JSON.stringify(res.content)}`).toBeFalsy();
      expect(res.structuredContent, `${tool.name} returned structuredContent`).toBeDefined();
      const called = calls.slice(before).map((c) => `${c.method} ${c.path}`);
      if (route) expect(called, tool.name).toContain(route);
      else expect(called, tool.name).toEqual([]);
    }
    await client.close();
  });

  it("sends a damage split as amounts", async () => {
    const assign = fixture(index["combat GET /game#assign"]) as { pendingDecision: { id: number; kind: string; amount: number } };
    expect(assign.pendingDecision).toMatchObject({ kind: "assign", amount: 3 });
    const { bridge, calls } = fakeBridge({ "POST /game/decide": fixture(index["game POST /game/decide"]) });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_decide", arguments: { id: assign.pendingDecision.id, amounts: [2, 1] } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(calls.find((c) => c.path === "/game/decide")?.body).toEqual({ id: assign.pendingDecision.id, choices: [], amounts: [2, 1] });
    await client.close();
  });
});
