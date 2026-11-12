import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventLog, YOUR_MOVE } from "../src/events.js";
import { fileLog, logEmitted } from "../src/log.js";
import { createServer, skillCatalog } from "../src/server.js";
import { fakeBridge } from "./helpers.js";

describe("the activity log", () => {
  it("is off without a path", () => {
    expect(fileLog("")).toBeUndefined();
  });

  it("records an emitted event, the poll that returns it and a tool call", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "forge-log-")), "activity.log");
    const log = fileLog(path)!;
    const events = new EventLog();
    logEmitted(events, log);
    const skills = await skillCatalog();
    const { bridge } = fakeBridge({ "GET /game/log": { lines: [] } });
    const handler = createMcpHandler(() => createServer({ bridge, skills, events, log }));
    const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));

    const Any = z.looseObject({});
    await client.request({ method: "events/poll", params: { name: YOUR_MOVE, cursor: null } }, Any);
    const first = (await client.request({ method: "events/poll", params: { name: YOUR_MOVE, cursor: null } }, Any)) as { cursor: string };
    const emitted = events.emit(YOUR_MOVE, { kind: "priority" });
    await client.request({ method: "events/poll", params: { name: YOUR_MOVE, cursor: first.cursor } }, Any);
    await client.callTool({ name: "forge_game_log", arguments: {} });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[forge-mcp-server\] event forge\.your_move \S+ kind=priority$/);
    expect(lines[1]).toContain(`poll forge.your_move returned ${emitted.eventId}`);
    expect(lines[2]).toContain("tool forge_game_log started ");
  });
});
