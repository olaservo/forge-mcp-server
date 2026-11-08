import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Bridge } from "../src/bridge.js";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import { STATUS_URI, createServer, skillCatalog } from "../src/server.js";
import { StatusWatcher } from "../src/watcher.js";

/** A fake Forge bridge: records calls and answers with canned JSON. */
function fakeBridge(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = responses[key];
    if (hit === undefined) {
      return new Response(JSON.stringify({ error: `unknown route ${key}` }), { status: 400 });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bridge: new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl }), calls };
}

async function connect(bridge: Bridge, bus?: InMemoryServerEventBus) {
  const skills = await skillCatalog();
  const handler = createMcpHandler(() => createServer({ bridge, skills }), bus ? { bus } : {});
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return client;
}

const status = {
  revision: 3,
  connection: { connected: true, host: "127.0.0.1", port: 36743, name: "Agent" },
  lobby: { mySlot: 1, slots: [] },
  draft: { pickPending: true, packSize: 15 },
  game: { inGame: false },
  chat: [],
};

describe("forge-mcp-server", () => {
  it("lists the forge tools and the skills", async () => {
    const { bridge } = fakeBridge({});
    const client = await connect(bridge);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("forge_status");
    expect(names).toContain("forge_draft_pick");
    expect(names).toContain("forge_game_decide");
    expect(names).toContain("forge_wait");

    const skills = new SkillsClient(client);
    expect(skills.supported).toBe(true);
    const { skills: entries } = await skills.list();
    const skillNames = entries.map((e) => e.frontmatter.name).sort();
    expect(skillNames).toEqual(["forge-drafter", "forge-player"]);
    const player = entries.find((e) => e.frontmatter.name === "forge-player")!;
    const manifest = await skills.read(player);
    expect(manifest.verified).toBe(true);
    expect(manifest.body).toContain("forge_game_state");
    await client.close();
  });

  it("routes forge_status and forge_draft_pick to the bridge", async () => {
    const { bridge, calls } = fakeBridge({
      "GET /status": status,
      "POST /draft/pick": { picked: { name: "Lightning Bolt" }, packNumber: 1, pickNumber: 1 },
    });
    const client = await connect(bridge);

    const st = await client.callTool({ name: "forge_status", arguments: {} });
    expect(st.isError).toBeFalsy();
    expect((st.structuredContent as typeof status).revision).toBe(3);

    const pick = await client.callTool({ name: "forge_draft_pick", arguments: { card: "Lightning Bolt" } });
    expect(pick.isError).toBeFalsy();
    expect(calls.find((c) => c.path === "/draft/pick")?.body).toEqual({ card: "Lightning Bolt" });
    await client.close();
  });

  it("routes forge_game_act quit to the bridge", async () => {
    const { bridge, calls } = fakeBridge({ "POST /game/act": { inGame: false, gameOver: true } });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "quit" } });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.path === "/game/act")?.body).toEqual({ action: "quit" });
    await client.close();
  });

  it("advertises an outputSchema on every tool and validates a full game state against it", async () => {
    const game = {
      inGame: true, finished: false, prompt: "Declare attackers", promptCard: null,
      buttons: { ok: "OK", okEnabled: true, cancel: "Cancel", cancelEnabled: false },
      incorrectActions: 0, pendingDecision: null, messages: [], turn: 4, phase: "COMBAT_DECLARE_ATTACKERS",
      activePlayer: "Agent", gameOver: false, winner: "", me: "Agent",
      players: [
        { id: 1, name: "Agent", life: 20, hasPriority: true, isMe: true, handSize: 5, librarySize: 30, graveyardSize: 0, exileSize: 0,
          battlefield: [{ id: 7, name: "Grizzly Bears", zone: "Battlefield", controller: "Agent", tapped: false, sick: false, attacking: false, blocking: false, damage: 0, token: false, faceDown: false, type: "Creature - Bear", manaCost: "{1}{G}", power: 2, toughness: 2, text: "" }],
          graveyard: [], hand: [] },
        { id: 2, name: "HostAI", life: 18, hasPriority: false, isMe: false, handSize: 6, librarySize: 29, graveyardSize: 1, exileSize: 0, battlefield: [], graveyard: [] },
      ],
      stack: [], combat: [{ attacker: "Grizzly Bears", attackerId: 7, defender: "HostAI", blockers: [] }],
    };
    const { bridge } = fakeBridge({ "GET /game": game, "GET /status": status });
    const client = await connect(bridge);
    const { tools } = await client.listTools();
    expect(tools.filter((t) => !t.outputSchema).map((t) => t.name)).toEqual([]);
    const res = await client.callTool({ name: "forge_game_state", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as typeof game).players[0].battlefield[0].name).toBe("Grizzly Bears");
    const st = await client.callTool({ name: "forge_status", arguments: {} });
    expect(st.isError).toBeFalsy();
    await client.close();
  });

  it("pushes resources/updated for forge://status to subscriptions/listen subscribers", async () => {
    const { bridge } = fakeBridge({ "GET /status": status });
    const bus = new InMemoryServerEventBus();
    const client = await connect(bridge, bus);
    const received = new Promise<string>((resolve) => {
      client.setNotificationHandler("notifications/resources/updated", (n) => resolve(n.params.uri));
    });
    const sub = await client.listen({ resourceSubscriptions: [STATUS_URI] });
    expect(sub.honoredFilter.resourceSubscriptions).toEqual([STATUS_URI]);
    bus.publish({ kind: "resource_updated", uri: STATUS_URI });
    expect(await received).toBe(STATUS_URI);
    await sub.close();
    await client.close();
  });

  it("status watcher reports each new bridge revision once and skips the seed", async () => {
    const revisions = [3, 3, 4, 4, 5];
    let pending: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as URL).toString());
      expect(url.pathname).toBe("/wait");
      const next = revisions.shift();
      if (next === undefined) await new Promise<void>((r) => (pending = r)); // park like a long poll
      return new Response(JSON.stringify({ revision: next ?? 5 }), { status: 200 });
    };
    const seen: number[] = [];
    const watcher = new StatusWatcher(new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl }), (r) => {
      seen.push(r);
    }, { sleep: async () => {} });
    watcher.start();
    while (revisions.length > 0) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();
    pending?.();
    expect(seen).toEqual([4, 5]);
  });

  it("reports bridge errors as tool errors, not protocol errors", async () => {
    const { bridge } = fakeBridge({});
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_draft_pool", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unknown route");
    await client.close();
  });
});
