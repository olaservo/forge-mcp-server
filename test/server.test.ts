import { describe, expect, it } from "vitest";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import { Bridge } from "../src/bridge.js";
import { STATUS_URI } from "../src/server.js";
import { StatusWatcher } from "../src/watcher.js";
import { connect, fakeBridge } from "./helpers.js";

const status = {
  revision: 3,
  connection: { connected: true, host: "127.0.0.1", port: 36743, name: "Agent" },
  lobby: { mySlot: 1, slots: [] },
  draft: { pickPending: true, packSize: 15 },
  game: { inGame: false },
  chat: [],
};

describe("forge-mcp-server", () => {
  it("lists the forge tools, each with an output schema, and the skills", async () => {
    const { bridge } = fakeBridge({});
    const client = await connect(bridge);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("forge_status");
    expect(names).toContain("forge_draft_pick");
    expect(names).toContain("forge_game_decide");
    expect(names).toContain("forge_wait");
    expect(tools.filter((t) => !t.outputSchema).map((t) => t.name)).toEqual([]);

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
