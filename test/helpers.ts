import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryServerEventBus, createMcpHandler } from "@modelcontextprotocol/server";
import { PNG } from "pngjs";
import { Bridge } from "../src/bridge.js";
import type { EventLog } from "../src/events.js";
import { createServer, skillCatalog } from "../src/server.js";

/** A fake Forge bridge: records calls and answers with canned JSON keyed by `METHOD /path`. */
export function fakeBridge(responses: Record<string, unknown>) {
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

/** An in-process MCP client over the Streamable HTTP handler, with no sockets. */
export async function connect(bridge: Bridge, bus?: InMemoryServerEventBus, events?: EventLog) {
  const skills = await skillCatalog();
  const handler = createMcpHandler(() => createServer({ bridge, skills, events }), bus ? { bus } : {});
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return client;
}

/** Writes an opaque avatar sheet of `columns` x `rows` 100 px tiles, with the tiles in `empty` left transparent. Returns its path. */
export function avatarSheet(columns: number, rows: number, empty: [number, number][] = []): string {
  const png = new PNG({ width: columns * 100, height: rows * 100 });
  for (let i = 0; i < png.data.length; i += 4) {
    const x = Math.floor(((i / 4) % png.width) / 100);
    const y = Math.floor(i / 4 / png.width / 100);
    const isEmpty = empty.some(([ex, ey]) => ex === x && ey === y);
    png.data.set([40 * x, 60 * y, 120, isEmpty ? 0 : 255], i);
  }
  const path = join(mkdtempSync(join(tmpdir(), "forge-avatars-")), "sprite_avatars.png");
  writeFileSync(path, PNG.sync.write(png));
  return path;
}
