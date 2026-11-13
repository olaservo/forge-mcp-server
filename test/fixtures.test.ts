import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as out from "../src/schemas.js";
import { avatarSheet, connect, fakeBridge } from "./helpers.js";

/** Real bridge payloads, recorded by forge-agent-bridge's tests (`BridgeHttp.saveFixtures`) while a draft and a match ran in-process. The rigged, scry, surveil and reveal recordings come from its one-situation tests. */
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
  "POST /lobby/deck": out.DeckResult,
  "POST /chat": out.OkResult,
  "GET /draft/pack": out.Draft,
  "POST /draft/pick": out.PickResult,
  "GET /draft/pool": out.Pool,
  "GET /game": out.Game,
  "GET /game/log": out.LogResult,
  "POST /game/act": out.Game,
  "POST /game/decide": out.Game,
};

/** "game GET /game#decision" -> route "GET /game". */
const routeOf = (key: string) => key.split(" ").slice(1).join(" ").split("#")[0];

describe("bridge fixtures", () => {
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
    process.env.FORGE_AVATARS = avatarSheet(3, 2);
    const { bridge, calls } = fakeBridge(responses);
    const client = await connect(bridge);
    const args: Record<string, Record<string, unknown>> = {
      forge_status: {},
      forge_connect: { host: "127.0.0.1", port: 36743, name: "Agent" },
      forge_disconnect: {},
      forge_lobby_ready: { ready: true },
      forge_lobby_avatar: { index: 3 },
      forge_lobby_avatars: { page: 0 },
      forge_lobby_deck: { dck: "[Main]\n40 Plains" },
      forge_chat: { text: "hi" },
      forge_draft_pack: {},
      forge_draft_pick: { card: "0" },
      forge_draft_pool: {},
      forge_game_state: {},
      forge_game_log: { since: 0 },
      forge_game_act: { action: "ok" },
      forge_game_decide: { id: 1, choices: [0] },
      forge_wait: { since: 3, timeout: 5 },
    };
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(args).sort());
    for (const tool of tools) {
      const res = await client.callTool({ name: tool.name, arguments: args[tool.name] });
      expect(res.isError, `${tool.name}: ${JSON.stringify(res.content)}`).toBeFalsy();
      expect(res.structuredContent, `${tool.name} returned structuredContent`).toBeDefined();
    }
    // forge_lobby_avatars reads a file and does not call the bridge.
    expect(calls.length).toBeGreaterThanOrEqual(tools.length - 1);
    await client.close();
  });
});
