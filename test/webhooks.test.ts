import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHAT, EventLog, YOUR_MOVE } from "../src/events.js";
import { skillCatalog } from "../src/server.js";
import { listenHttp } from "../src/transports/http.js";
import { type SubscribeResult, WebhookHub, type WebhookPost, isPublicAddress, isSigningSecret, subscriptionId, webhookPost } from "../src/webhooks.js";
import { connect, fakeBridge } from "./helpers.js";

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;
const URL_A = "https://receiver.example.com/mcp-events/callback_1";
const Any = z.looseObject({});
const isVerification = (body: string) => body.includes(`"verification"`);

/** A callback endpoint that echoes verification challenges and answers events with the queued statuses, then 200. */
function receiver(statuses: number[] = []) {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const post: WebhookPost = async (url, headers, body) => {
    posts.push({ url, headers, body });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    return { status: statuses.shift() ?? 200, body: "" };
  };
  const events = () => posts.filter((p) => !isVerification(p.body));
  return { posts, post, events };
}

const subscribeParams = (secret: string, extra: Record<string, unknown> = {}) => ({
  name: YOUR_MOVE,
  arguments: {},
  delivery: { mode: "webhook", url: URL_A, secret },
  cursor: null,
  ...extra,
});

describe("webhook delivery", () => {
  it("subscribes, verifies the callback, delivers signed events and unsubscribes", async () => {
    const log = new EventLog();
    const { posts, post, events } = receiver();
    const hub = new WebhookHub(log, { post });
    const client = await connect(fakeBridge({}).bridge, undefined, log, { hub, principal: "ola" });
    const secret = newSecret();

    const listed = (await client.request({ method: "events/list", params: {} }, Any)) as { events: { delivery: string[] }[] };
    expect(listed.events.map((e) => e.delivery)).toEqual([["poll", "webhook"], ["poll", "webhook"]]);

    const sub = (await client.request({ method: "events/subscribe", params: subscribeParams(secret) }, Any)) as unknown as SubscribeResult;
    expect(sub).toMatchObject({ id: subscriptionId("ola", URL_A, YOUR_MOVE, {}), cursor: null, truncated: false });
    expect(Date.parse(sub.refreshBefore!) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(sub.deliveryStatus).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers["webhook-id"]).toMatch(/^msg_verification_/);
    new Webhook(secret).verify(posts[0]!.body, posts[0]!.headers);

    const emitted = log.emit(YOUR_MOVE, { kind: "priority", prompt: "Priority: Agent" });
    log.emit(CHAT, { from: "Ola", text: "not subscribed" });
    await hub.idle();
    expect(events()).toHaveLength(1);
    const delivery = events()[0]!;
    expect(delivery.url).toBe(URL_A);
    expect(delivery.headers).toMatchObject({ "webhook-id": emitted.eventId, "x-mcp-subscription-id": sub.id, "content-type": "application/json" });
    expect(new Webhook(secret).verify(delivery.body, delivery.headers)).toEqual({ ...emitted, cursor: null });

    const refreshed = (await client.request({ method: "events/subscribe", params: subscribeParams(secret) }, Any)) as unknown as SubscribeResult;
    expect(refreshed.id).toBe(sub.id);
    expect(refreshed.deliveryStatus).toMatchObject({ active: true, lastError: null });
    expect(posts.filter((p) => isVerification(p.body))).toHaveLength(1);
    expect(hub.size).toBe(1);

    const unsubscribe = { name: YOUR_MOVE, arguments: {}, delivery: { mode: "webhook", url: URL_A } };
    await client.request({ method: "events/unsubscribe", params: unsubscribe }, Any);
    await client.request({ method: "events/unsubscribe", params: unsubscribe }, Any);
    log.emit(YOUR_MOVE, { kind: "priority" });
    await hub.idle();
    expect(events()).toHaveLength(1);
    await client.close();
  });

  it("refuses subscriptions it must not accept", async () => {
    const log = new EventLog();
    const bridge = fakeBridge({}).bridge;
    const hub = new WebhookHub(log, { post: async () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }) });
    const subscribe = (client: Awaited<ReturnType<typeof connect>>, params: Record<string, unknown>) =>
      client.request({ method: "events/subscribe", params }, Any);

    const noHub = await connect(bridge, undefined, log);
    await expect(subscribe(noHub, subscribeParams(newSecret()))).rejects.toMatchObject({ code: -32026 });
    const anonymous = await connect(bridge, undefined, log, { hub });
    await expect(subscribe(anonymous, subscribeParams(newSecret()))).rejects.toMatchObject({ code: -32024 });

    const client = await connect(bridge, undefined, log, { hub, principal: "ola" });
    await expect(subscribe(client, { ...subscribeParams(newSecret()), name: "nope" })).rejects.toMatchObject({ code: -32023 });
    await expect(subscribe(client, { ...subscribeParams(newSecret()), arguments: { kind: "priority" } })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe(client, subscribeParams("whsec_c2hvcnQ="))).rejects.toMatchObject({ code: -32602 });
    const http = { ...subscribeParams(newSecret()), delivery: { mode: "webhook", url: "http://receiver.example.com/x", secret: newSecret() } };
    await expect(subscribe(client, http)).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe(client, subscribeParams(newSecret()))).rejects.toMatchObject({ code: -32027, data: { reason: "challenge_failed" } });
    expect(hub.size).toBe(0);
    for (const c of [noHub, anonymous, client]) await c.close();
  });

  it("retries a failed delivery with the same webhook-id and stops on 410", async () => {
    const log = new EventLog();
    const { post, events } = receiver([500, 200, 410]);
    const hub = new WebhookHub(log, { post, retryDelaysMs: [0, 0] });
    await hub.subscribe("ola", subscribeParams(newSecret()));

    const first = log.emit(YOUR_MOVE, { kind: "priority" });
    await hub.idle();
    expect(events().map((p) => p.headers["webhook-id"])).toEqual([first.eventId, first.eventId]);

    log.emit(YOUR_MOVE, { kind: "decision" });
    await hub.idle();
    expect(events()).toHaveLength(3);
    const status = (await hub.subscribe("ola", subscribeParams(newSecret()))).deliveryStatus;
    expect(status).toMatchObject({ lastError: "http_4xx" });
  });

  it("signs with the old and new secret after a rotation", async () => {
    const log = new EventLog();
    const { post, events } = receiver();
    const hub = new WebhookHub(log, { post });
    const [old, next] = [newSecret(), newSecret()];
    await hub.subscribe("ola", subscribeParams(old));
    await hub.subscribe("ola", subscribeParams(next));
    log.emit(YOUR_MOVE, { kind: "priority" });
    await hub.idle();
    const { headers, body } = events()[0]!;
    expect(headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    new Webhook(old).verify(body, headers);
    new Webhook(next).verify(body, headers);
  });

  it("expires subscriptions, and keeps them across a restart when given a file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "forge-subs-")), "subscriptions.json");
    let now = Date.parse("2026-11-11T12:00:00Z");
    const { post, posts, events } = receiver();
    const first = new WebhookHub(new EventLog(), { post, file, now: () => now });
    const forever = await first.subscribe("ola", subscribeParams(newSecret(), { ttlMs: null }));
    expect(forever.refreshBefore).toBeNull();
    const short = await first.subscribe("ola", { ...subscribeParams(newSecret(), { ttlMs: 1000 }), name: CHAT });
    expect(short.refreshBefore).toBe("2026-11-11T12:01:00.000Z");

    now += 2 * 60 * 1000;
    const log = new EventLog();
    const second = new WebhookHub(log, { post, file, now: () => now });
    expect(second.size).toBe(2);
    log.emit(CHAT, { from: "Ola", text: "after expiry" });
    log.emit(YOUR_MOVE, { kind: "priority" });
    await second.idle();
    expect(events().map((p) => p.headers["x-mcp-subscription-id"])).toEqual([forever.id]);
    expect(second.size).toBe(1);
    // the callback was verified before the restart, so the refresh sends no second challenge
    const verifications = posts.length - events().length;
    await second.subscribe("ola", subscribeParams(newSecret()));
    expect(posts.length - events().length).toBe(verifications);

    const memoryOnly = new WebhookHub(new EventLog(), { post });
    expect((await memoryOnly.subscribe("ola", subscribeParams(newSecret(), { ttlMs: null }))).refreshBefore).not.toBeNull();
  });

  it("checks secrets and callback addresses", async () => {
    expect(isSigningSecret(newSecret())).toBe(true);
    expect(isSigningSecret(randomBytes(32).toString("base64"))).toBe(false);
    expect(isSigningSecret(`whsec_${randomBytes(65).toString("base64")}`)).toBe(false);
    for (const address of ["127.0.0.1", "10.0.0.234", "192.168.1.5", "169.254.169.254", "::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("104.18.33.45")).toBe(true);
    expect(isPublicAddress("2606:4700::6812:212d")).toBe(true);
    // the default sender refuses http, address literals and names that resolve to non-public addresses
    for (const url of ["http://receiver.example.com/x", "https://10.0.0.234/x", "https://localhost:9/x"]) {
      await expect(webhookPost()(url, {}, "{}"), url).rejects.toMatchObject({ reason: "connection_refused" });
    }
  });

  it("serves the whole exchange over sockets behind a bearer token", async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const callback = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        const parsed = JSON.parse(body) as { challenge?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(parsed.challenge ? { challenge: parsed.challenge } : {}));
      });
    });
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    const callbackUrl = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/hook`;

    const log = new EventLog();
    const hub = new WebhookHub(log, { insecure: true });
    const server = listenHttp({ bridge: fakeBridge({}).bridge, skills: await skillCatalog(), events: log, port: 0, token: "s3cret", webhooks: hub });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rpc = async (method: string, params: unknown, token?: string, extra: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${server.port()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      const json = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
      return { status: res.status, message: JSON.parse(json || "{}") as { result?: Record<string, any>; error?: { code: number } } };
    };

    expect((await rpc("events/list", {})).status).toBe(401);
    expect((await rpc("events/list", {}, "wrong")).status).toBe(401);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, "s3cret");
    expect(init.message.result?.capabilities).toMatchObject({ events: {}, tools: {} });

    const envelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" };
    const discover = await rpc("server/discover", { _meta: envelope }, "s3cret", modern);
    expect(discover.message.result?.capabilities).toMatchObject({ events: {}, extensions: { "io.modelcontextprotocol/events": {} } });

    const secret = newSecret();
    const sub = await rpc("events/subscribe", { name: YOUR_MOVE, arguments: {}, delivery: { mode: "webhook", url: callbackUrl, secret }, cursor: null }, "s3cret");
    expect(sub.message.result).toMatchObject({ id: expect.stringMatching(/^sub_/), cursor: null });
    const emitted = log.emit(YOUR_MOVE, { kind: "game_over", prompt: "Game over. Winner: Ola" });
    await hub.idle();
    expect(received).toHaveLength(2);
    const event = received[1]!;
    expect(event.headers["webhook-id"]).toBe(emitted.eventId);
    expect(new Webhook(secret).verify(event.body, event.headers as Record<string, string>)).toMatchObject({ name: YOUR_MOVE, data: { kind: "game_over" } });

    server.close();
    callback.close();
  });

  it("takes the principal from a proxy that holds the proxy token", async () => {
    const log = new EventLog();
    const hub = new WebhookHub(log, { insecure: true });
    const server = listenHttp({ bridge: fakeBridge({}).bridge, skills: await skillCatalog(), events: log, port: 0, proxyToken: "pr0xy", webhooks: hub });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callback = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge: (JSON.parse(body) as { challenge?: string }).challenge }));
      });
    });
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/hook`;
    const subscribe = async (headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${server.port()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: YOUR_MOVE, arguments: {}, delivery: { mode: "webhook", url, secret: newSecret() }, cursor: null } }),
      });
      const text = await res.text();
      const json = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
      return { status: res.status, id: (JSON.parse(json) as { result?: { id?: string } }).result?.id };
    };

    expect((await subscribe({ "x-forge-principal": "google:1" })).status).toBe(401);
    expect((await subscribe({ authorization: "Bearer wrong", "x-forge-principal": "google:1" })).status).toBe(401);
    expect((await subscribe({ authorization: "Bearer pr0xy" })).status).toBe(401);
    const one = await subscribe({ authorization: "Bearer pr0xy", "x-forge-principal": "google:1" });
    const two = await subscribe({ authorization: "Bearer pr0xy", "x-forge-principal": "google:2" });
    expect(one.id).toBe(subscriptionId("google:1", url, YOUR_MOVE, {}));
    expect(two.id).toBe(subscriptionId("google:2", url, YOUR_MOVE, {}));

    server.close();
    callback.close();
  });
});
