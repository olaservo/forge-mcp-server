import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copilotView } from "../src/copilot.js";
import { LobbyHost } from "../src/host.js";
import * as out from "../src/schemas.js";
import { fakeBridge, connect, fakeHost } from "./helpers.js";

type Json = Record<string, unknown>;

/** `GET /copilot` bodies recorded by forge-agent-bridge's CopilotHostTest: a target prompt, and a scry dialog. */
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Json;
const recorded = fixture("copilot-GET_copilot.json");
const withDialog = fixture("copilot-GET_copilot_dialog.json");

const settings = { port: 36750, seats: 2, limited: true, games: 1, copilot: "Johnny" };

/** This server's own bridge, with no seat anywhere. */
const unseated = fakeBridge({ "GET /status": { connection: { connected: false, host: null, port: null, name: null } } }).bridge;

/** A host whose MatchHost is a fake process. `ready` is its ready line, given the copilot port it was started with. */
function copilotHost(ready = (port: number) => `MATCH_HOST_READY port=36750 copilotPort=${port} copilot=Johnny\n`) {
  const spawned: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const killed: number[] = [];
  const fakeSpawn = ((_command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    spawned.push({ args, env: options.env });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => killed.push(spawned.length) });
    setImmediate(() => child.stdout.emit("data", Buffer.from(ready(41234))));
    return child;
  }) as unknown as typeof spawn;
  const host = new LobbyHost({ jar: "forge.jar", bridgeJar: "bridge.jar", cwd: ".", spawn: fakeSpawn, addresses: () => ["192.0.2.10"], freePort: async () => 41234 });
  return { host, spawned, killed };
}

/** A copilot port that answers the bodies in turn, the last one from then on, and 401 without the host's token. */
function copilotPort(host: LobbyHost, bodies: Json[]) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(input), authorization });
    if (authorization !== `Bearer ${host.copilot()?.token}`) return new Response(JSON.stringify({ error: "no" }), { status: 401 });
    const body = bodies[Math.min(calls.length, bodies.length) - 1];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, calls };
}

describe("forge_host with a copilot", () => {
  it("passes the seat and a loopback port as arguments and the token by environment", async () => {
    const { host, spawned } = copilotHost();
    const state = await host.start(settings);
    expect(state).toMatchObject({ running: true, copilot: "Johnny" });
    const { args, env } = spawned[0];
    expect(args.slice(args.indexOf("--limited"))).toEqual(["--limited", "--copilot", "Johnny", "--copilot-port", "41234", "--exit-with-parent"]);
    const access = host.copilot()!;
    expect(access).toMatchObject({ seat: "Johnny", url: "http://127.0.0.1:41234/copilot" });
    expect(access.token).toMatch(/^[0-9a-f]{64}$/);
    expect(env.FORGE_COPILOT_TOKEN).toBe(access.token);
    expect(args.join(" ")).not.toContain(access.token);
    expect(JSON.stringify(state)).not.toContain(access.token);
    expect(out.Host.parse(state)).toMatchObject({ copilot: "Johnny" });
  });

  it("has no copilot without the argument, and forgets it when the host stops", async () => {
    const plain = fakeHost();
    await plain.host.start({ port: 36750, seats: 2, limited: true, games: 1 });
    expect(plain.host.copilot()).toBeUndefined();
    expect(plain.spawned[0]).not.toContain("--copilot");
    const { host } = copilotHost();
    await host.start(settings);
    await expect(host.start({ ...settings, copilot: "Ola" })).rejects.toThrow("Already hosting on port 36750");
    host.stop();
    expect(host.copilot()).toBeUndefined();
  });

  it("refuses a copilot on a bridge jar that ignores it", async () => {
    const { host, killed } = copilotHost(() => "MATCH_HOST_READY port=36750\n");
    await expect(host.start(settings)).rejects.toThrow("forge_host with copilot needs forge-agent-bridge 0.1.11 or later");
    expect(killed).toEqual([1]);
    expect(host.copilot()).toBeUndefined();
  });
});

describe("forge_copilot_view", () => {
  it("shapes the host's answer as a seat's view and sends the token", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const port = copilotPort(host, [recorded]);
    const view = await copilotView(host, unseated, { fetch: port.fetch });
    expect(port.calls).toEqual([{ url: "http://127.0.0.1:41234/copilot", authorization: `Bearer ${host.copilot()!.token}` }]);
    expect(() => out.CopilotView.parse(view)).not.toThrow();
    expect(view).toMatchObject({ seat: "Johnny", watching: true, revision: recorded.revision, prompt: recorded.prompt, promptCount: recorded.promptCount });
    const me = (recorded.players as Json[]).find((p) => p.isMe === true)!;
    const other = (recorded.players as Json[]).find((p) => p.isMe !== true)!;
    expect((view.hand as Json[]).map((c) => c.name)).toEqual((me.hand as Json[]).map((c) => c.name));
    expect((view.board as Json[]).map((p) => p.name)).toEqual([me.name, other.name].sort((a, b) => (recorded.players as Json[]).findIndex((p) => p.name === a) - (recorded.players as Json[]).findIndex((p) => p.name === b)));
    expect((view.selection as Json).cards).toHaveLength(((recorded.selection as Json).cards as Json[]).length);
    // rules text once per card name
    const names = Object.keys(view.cardText as Json);
    expect(names).toContain("Magma Jet");
    const again = await copilotView(host, unseated, { fetch: port.fetch });
    expect(again.cardText).toBeUndefined();
    // the recorded opponent hand is a count, and the shaped view adds no hand for it
    expect(other.hand).toBeUndefined();
    expect(JSON.stringify(view.board)).not.toContain('"hand"');
  });

  it("carries an open dialog with the options the seat is shown", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const view = await copilotView(host, unseated, { fetch: copilotPort(host, [withDialog]).fetch });
    expect(view.dialog).toEqual(withDialog.dialog);
    expect(((view.dialog as Json).options as unknown[]).length).toBe(2);
    expect(view.selection).toBeUndefined();
  });

  it("gives the game log lines that are new since the last read", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const first = { ...recorded, logCount: 3, log: ["Turn: Turn 1 (Johnny)", "Land: Johnny played Mountain (31)", "Phase: Johnny's End step"] };
    const second = { ...first, revision: Number(recorded.revision) + 1, logCount: 5, log: [...first.log, "Turn: Turn 2 (Opponent)", "Land: Opponent played Forest (60)"] };
    const port = copilotPort(host, [first, first, second]);
    const view = await copilotView(host, unseated, { fetch: port.fetch });
    expect((view.since as Json).log).toEqual(["Turn: Turn 1 (Johnny)", "Land: Johnny played Mountain (31)"]);
    expect(view.log).toBeUndefined();
    expect((await copilotView(host, unseated, { fetch: port.fetch })).since).toBeUndefined();
    expect(((await copilotView(host, unseated, { fetch: port.fetch })).since as Json).log).toEqual(["Turn: Turn 2 (Opponent)", "Land: Opponent played Forest (60)"]);
  });

  it("waits for the revision to change, and says when it did not", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const later = { ...recorded, revision: Number(recorded.revision) + 3 };
    const port = copilotPort(host, [recorded, recorded, later]);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const view = await copilotView(host, unseated, { since: Number(recorded.revision), timeout: 30, fetch: port.fetch, sleep });
    expect(view.revision).toBe(later.revision);
    expect(view.unchanged).toBeUndefined();
    expect(port.calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
    const same = await copilotView(host, unseated, { since: Number(later.revision), timeout: 0, fetch: port.fetch, sleep });
    expect(same).toMatchObject({ unchanged: true, revision: later.revision });
  });

  it("says so when the seat is in no game, when the host has no copilot, and when the port refuses", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const idle = await copilotView(host, unseated, { fetch: copilotPort(host, [{ seat: "Johnny", watching: false }]).fetch });
    expect(idle).toEqual({ seat: "Johnny", watching: false, message: "Johnny is in no game now. The view starts when a game with that seat starts." });
    const refusing: typeof fetch = async () => new Response("{}", { status: 401 });
    await expect(copilotView(host, unseated, { fetch: refusing })).rejects.toThrow("answered 401");
    const none = await copilotView(fakeHost().host, unseated);
    expect(none.watching).toBe(false);
    expect(String(none.message)).toContain("has no copilot");
  });

  it("is a read-only tool, and no tool or argument acts for the watched seat", async () => {
    const client = await connect(fakeBridge({}).bridge);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "forge_copilot_view")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toContain("no way to act for the watched seat");
    expect(Object.keys((tool.inputSchema as { properties: Json }).properties).sort()).toEqual(["since", "timeout"]);
    expect(tools.filter((t) => t.name.includes("copilot")).map((t) => t.name)).toEqual(["forge_copilot_view"]);
    const res = await client.callTool({ name: "forge_copilot_view", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ watching: false });
    await client.close();
  });
});

describe("a copilot session holds no seat in the game it watches", () => {
  const seated = (port: number, name = "Opponent", host = "127.0.0.1") =>
    fakeBridge({ "GET /status": { connection: { connected: true, host, port, name } }, "POST /connect": { connection: { connected: true, host, port, name } } });

  it("forge_copilot_view is refused while this server's bridge is seated on the host it started", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const port = copilotPort(host, [recorded]);
    await expect(copilotView(host, seated(36750).bridge, { fetch: port.fetch })).rejects.toThrow(
      'This server holds the seat "Opponent" on the host it started. A copilot session does not play in the game it watches.',
    );
    // Under the watched name too, and by another name for this machine.
    await expect(copilotView(host, seated(36750, "Johnny").bridge, { fetch: port.fetch })).rejects.toThrow('holds the seat "Johnny"');
    await expect(copilotView(host, seated(36750, "Opponent", "localhost").bridge, { fetch: port.fetch })).rejects.toThrow("does not play in the game it watches");
    await expect(copilotView(host, seated(36750, "Opponent", "[::1]").bridge, { fetch: port.fetch })).rejects.toThrow("does not play in the game it watches");
    expect(port.calls).toEqual([]);
    // A seat on another host, and a bridge that is down, are no seat here.
    expect(await copilotView(host, seated(36999).bridge, { fetch: port.fetch })).toMatchObject({ watching: true });
    expect(await copilotView(host, seated(36750, "Opponent", "192.0.2.77").bridge, { fetch: port.fetch })).toMatchObject({ watching: true });
    expect(await copilotView(host, fakeBridge({}).bridge, { fetch: port.fetch })).toMatchObject({ watching: true });
  });

  it("a seat taken while forge_copilot_view waits gets no view", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const later = { ...recorded, revision: Number(recorded.revision) + 1 };
    const port = copilotPort(host, [recorded, later]);
    let asked = 0;
    const joins = { isUp: async () => true, get: async () => ({ connection: { connected: asked++ > 0, host: "127.0.0.1", port: 36750, name: "Opponent" } }) } as unknown as Parameters<typeof copilotView>[1];
    await expect(copilotView(host, joins, { since: Number(recorded.revision), timeout: 30, fetch: port.fetch, sleep: async () => undefined })).rejects.toThrow("does not play in the game it watches");
  });

  it("forge_connect to the server's own host is refused while that host has a copilot", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const { bridge, calls } = seated(36750);
    const client = await connect(bridge, undefined, undefined, undefined, undefined, host);
    for (const address of ["127.0.0.1", "localhost", "192.0.2.10"]) {
      const res = await client.callTool({ name: "forge_connect", arguments: { host: address, port: 36750, name: "Opponent" } });
      expect(res.isError, address).toBe(true);
      expect(JSON.stringify(res.content)).toContain("This server's host watches Johnny for a copilot. A copilot session does not play in the game it watches.");
    }
    expect(calls.filter((c) => c.path === "/connect")).toEqual([]);
    // Another host is still open to it.
    const other = await client.callTool({ name: "forge_connect", arguments: { host: "127.0.0.1", port: 36999, name: "Opponent" } });
    expect(other.isError).toBeFalsy();
    // And the view is refused for the seat this fake bridge reports.
    const view = await client.callTool({ name: "forge_copilot_view", arguments: {} });
    expect(view.isError).toBe(true);
    expect(JSON.stringify(view.content)).toContain("does not play in the game it watches");
    await client.close();
  });

  it("forge_connect to a host without a copilot is not refused", async () => {
    const plain = fakeHost("MATCH_HOST_READY port=36750\n");
    await plain.host.start({ port: 36750, seats: 2, limited: true, games: 1 });
    const { bridge, calls } = seated(36750);
    const client = await connect(bridge, undefined, undefined, undefined, undefined, plain.host);
    const res = await client.callTool({ name: "forge_connect", arguments: { host: "127.0.0.1", port: 36750, name: "Opponent" } });
    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c.path === "/connect")).toHaveLength(1);
    await client.close();
  });

  it("forge_host with a copilot is refused while the bridge is already seated at that port", async () => {
    const { host, spawned } = copilotHost();
    const client = await connect(seated(36750).bridge, undefined, undefined, undefined, undefined, host);
    const res = await client.callTool({ name: "forge_host", arguments: { port: 36750, copilot: "Johnny" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('This server holds the seat \\"Opponent\\" at port 36750. A copilot session does not play in the game it watches.');
    expect(spawned).toHaveLength(0);
    // Without a copilot the same host is fine, and so is a copilot on another port.
    const plain = await client.callTool({ name: "forge_host", arguments: { port: 36750 } });
    expect(plain.isError).toBeFalsy();
    await client.close();
  });

  it("gives the host's reason when it watches nobody", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const reason = "2 seats are named Johnny, so the copilot watches neither in this game.";
    const view = await copilotView(host, unseated, { fetch: copilotPort(host, [{ seat: "Johnny", watching: false, reason }]).fetch });
    expect(view).toEqual({ seat: "Johnny", watching: false, message: reason });
  });
});
