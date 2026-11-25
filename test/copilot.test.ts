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
    const view = await copilotView(host, { fetch: port.fetch });
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
    const again = await copilotView(host, { fetch: port.fetch });
    expect(again.cardText).toBeUndefined();
    // the recorded opponent hand is a count, and the shaped view adds no hand for it
    expect(other.hand).toBeUndefined();
    expect(JSON.stringify(view.board)).not.toContain('"hand"');
  });

  it("carries an open dialog with the options the seat is shown", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const view = await copilotView(host, { fetch: copilotPort(host, [withDialog]).fetch });
    expect(view.dialog).toEqual(withDialog.dialog);
    expect(((view.dialog as Json).options as unknown[]).length).toBe(2);
    expect(view.selection).toBeUndefined();
  });

  it("waits for the revision to change, and says when it did not", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const later = { ...recorded, revision: Number(recorded.revision) + 3 };
    const port = copilotPort(host, [recorded, recorded, later]);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const view = await copilotView(host, { since: Number(recorded.revision), timeout: 30, fetch: port.fetch, sleep });
    expect(view.revision).toBe(later.revision);
    expect(view.unchanged).toBeUndefined();
    expect(port.calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
    const same = await copilotView(host, { since: Number(later.revision), timeout: 0, fetch: port.fetch, sleep });
    expect(same).toMatchObject({ unchanged: true, revision: later.revision });
  });

  it("says so when the seat is in no game, when the host has no copilot, and when the port refuses", async () => {
    const { host } = copilotHost();
    await host.start(settings);
    const idle = await copilotView(host, { fetch: copilotPort(host, [{ seat: "Johnny", watching: false }]).fetch });
    expect(idle).toEqual({ seat: "Johnny", watching: false, message: "Johnny is in no game now. The view starts when a game with that seat starts." });
    const refusing: typeof fetch = async () => new Response("{}", { status: 401 });
    await expect(copilotView(host, { fetch: refusing })).rejects.toThrow("answered 401");
    const none = await copilotView(fakeHost().host);
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
