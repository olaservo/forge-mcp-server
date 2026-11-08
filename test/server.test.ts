import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Bridge } from "../src/bridge.js";
import { createServer, skillCatalog } from "../src/server.js";

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

async function connect(bridge: Bridge) {
  const skills = await skillCatalog();
  const handler = createMcpHandler(() => createServer({ bridge, skills }));
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

  it("reports bridge errors as tool errors, not protocol errors", async () => {
    const { bridge } = fakeBridge({});
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_draft_pool", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unknown route");
    await client.close();
  });
});
