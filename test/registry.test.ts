import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import { type RegistryEntry, pruneRegistry, register, registryDir } from "../src/registry.js";
import { skillCatalog } from "../src/server.js";
import { listenHttp } from "../src/transports/http.js";
import { fakeBridge } from "./helpers.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "forge-registry-"));
const read = (dir: string) => JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8")) as RegistryEntry;
/** The pid of a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** Holds a port on 127.0.0.1, as another session's server does. */
async function takenPort(): Promise<number> {
  const holder = createNetServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  closers.push(() => holder.close());
  return (holder.address() as AddressInfo).port;
}

async function statusOver(url: string, token?: string) {
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined }));
  const result = await client.callTool({ name: "forge_status", arguments: {} });
  await client.close();
  return result.structuredContent;
}

describe("the server registry", () => {
  it("is ~/.forge-seat/servers unless FORGE_MCP_REGISTRY names a directory", () => {
    expect(registryDir({ FORGE_MCP_REGISTRY: "/somewhere" })).toBe("/somewhere");
    expect(registryDir({})).toMatch(/[\\/]\.forge-seat[\\/]servers$/);
  });

  it("writes one file per process, with no temporary file left, and removes it", () => {
    const dir = join(tempDir(), "servers");
    const entry = { url: "http://127.0.0.1:4000/mcp", source: "abcd1234", pid: process.pid, startedAt: "2026-11-22T00:00:00.000Z" };
    const remove = register(dir, entry);
    expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
    expect(read(dir)).toEqual(entry);
    remove();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("deletes the files of processes that have ended and keeps the rest", () => {
    const dir = tempDir();
    const dead = deadPid();
    writeFileSync(join(dir, `${dead}.json`), JSON.stringify({ url: "http://127.0.0.1:1/mcp", pid: dead }));
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ url: "http://127.0.0.1:2/mcp", pid: process.pid }));
    writeFileSync(join(dir, "notes.txt"), "kept");
    writeFileSync(join(dir, "broken.json"), "{");
    pruneRegistry(dir);
    expect(readdirSync(dir).sort()).toEqual(["broken.json", "notes.txt", `${process.pid}.json`].sort());
  });
});

describe("an HTTP endpoint for every server process", () => {
  it("takes a free port when the configured one is taken, and registers the address", async () => {
    const dir = tempDir();
    const port = await takenPort();
    const events = new EventLog();
    const server = listenHttp({ bridge: fakeBridge({ "GET /status": { revision: 3 } }).bridge, skills: await skillCatalog(), events, port, token: "s3cret", fallbackToFreePort: true, registry: dir });
    closers.push(() => server.close());
    expect(await server.listening).toBe(true);
    expect(server.port()).not.toBe(port);
    const url = `http://127.0.0.1:${server.port()}/mcp`;
    expect(server.url()).toBe(url);
    const entry = read(dir);
    expect(entry).toMatchObject({ url, source: events.source, pid: process.pid });
    // The file has the process's own token, never the configured one
    expect(entry.token).toMatch(/^[0-9a-f]{48}$/);
    const registry = join(dir, `${process.pid}.json`);
    expect(await statusOver(url, "s3cret")).toMatchObject({ events: { source: events.source, http: true, url, registry } });
    expect(await statusOver(url, entry.token)).toMatchObject({ events: { source: events.source, url } });
    const refused = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" });
    expect(refused.status).toBe(401);

    server.close();
    expect(existsSync(join(dir, `${process.pid}.json`))).toBe(false);
  });

  it("does not listen when the port is taken and no fallback was asked for", async () => {
    const server = listenHttp({ bridge: fakeBridge({}).bridge, skills: await skillCatalog(), events: new EventLog(), port: await takenPort() });
    closers.push(() => server.close());
    expect(await server.listening).toBe(false);
    expect(server.url()).toBeUndefined();
  });

  it("leaves the configured port open when no token is configured, and offers webhook delivery to a caller with the registry token", async () => {
    const dir = tempDir();
    const saved = process.env.FORGE_MCP_TOKEN;
    delete process.env.FORGE_MCP_TOKEN;
    closers.push(() => {
      if (saved !== undefined) process.env.FORGE_MCP_TOKEN = saved;
    });
    const server = listenHttp({ bridge: fakeBridge({ "GET /status": { revision: 3 } }).bridge, skills: await skillCatalog(), events: new EventLog(), port: 0, fallbackToFreePort: true, registry: dir });
    closers.push(() => server.close());
    expect(await server.listening).toBe(true);
    const { url, token } = read(dir);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(await statusOver(url)).toMatchObject({ events: { http: true, url } });

    const deliveryModes = async (bearer?: string) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "events/list", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} }),
      });
      const text = await res.text();
      const message = JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? text) as { result: { events: { delivery: string[] }[] } };
      return message.result.events[0]!.delivery;
    };
    expect(await deliveryModes()).not.toContain("webhook");
    expect(await deliveryModes(token)).toContain("webhook");
  });

  it("on a fallback port with no token configured, makes one up, writes it to the registry and refuses a request without it", async () => {
    const dir = tempDir();
    const port = await takenPort();
    const saved = process.env.FORGE_MCP_TOKEN;
    delete process.env.FORGE_MCP_TOKEN;
    closers.push(() => {
      if (saved !== undefined) process.env.FORGE_MCP_TOKEN = saved;
    });
    const server = listenHttp({ bridge: fakeBridge({ "GET /status": { revision: 3 } }).bridge, skills: await skillCatalog(), events: new EventLog(), port, fallbackToFreePort: true, registry: dir });
    closers.push(() => server.close());
    expect(await server.listening).toBe(true);
    const { url, token } = read(dir);
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    const refused = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(401);
    expect(await statusOver(url, token)).toMatchObject({ events: { http: true, url } });
  });
});
