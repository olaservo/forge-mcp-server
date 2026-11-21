import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { ProtocolError } from "@modelcontextprotocol/server";
import type { EventLog, EventOccurrence } from "./event-log.js";
import type { ActivityLog } from "./log.js";

/**
 * Webhook delivery for MCP Events (SEP-3415, "Webhook-Based Delivery"), written against what the
 * ChatGPT client accepts (developers.openai.com/plugins/build/mcp-events, read 2026-11-11). Two choices follow
 * ChatGPT where it differs from the SEP: `webhook-id` is the event's `eventId`, and `events/unsubscribe` of an
 * unknown subscription succeeds. `gap` and `terminated` envelopes are never sent; ChatGPT does not accept them.
 */
export const INVALID_PARAMS = -32602;
export const NOT_FOUND = -32023;
export const FORBIDDEN = -32024;
export const RESOURCE_EXHAUSTED = -32025;
export const UNSUPPORTED = -32026;
export const CALLBACK_ENDPOINT_ERROR = -32027;

export type DeliveryErrorReason = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export class DeliveryError extends Error {
  constructor(readonly reason: DeliveryErrorReason) {
    super(reason);
  }
}

/** POSTs a signed body to a callback URL. Rejects with a `DeliveryError` when no HTTP response arrives. */
export type WebhookPost = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const POST_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFIED_FOR_MS = 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 5 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 100;

/** Addresses a callback must not resolve to: the IANA special-purpose ranges. */
const notPublic = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) notPublic.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) notPublic.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !notPublic.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** DNS lookup that fails when any resolved address is not public. The socket connects to the address checked here. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (err, address, family) => {
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!err && !addresses.every(isPublicAddress)) {
      callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "ECONNREFUSED" }), "", 4);
      return;
    }
    (callback as (...args: unknown[]) => void)(err, address, family);
  });
};

function reasonOf(err: unknown): DeliveryErrorReason {
  if (err instanceof DeliveryError) return err.reason;
  const code = String((err as { code?: unknown })?.code ?? "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls_error";
  return "connection_refused";
}

/**
 * The default `WebhookPost`: https only, no redirects, addresses checked when the socket connects.
 * `insecure` also allows http and non-public addresses, for a receiver on the same machine.
 */
export function webhookPost({ insecure = false } = {}): WebhookPost {
  return (url, headers, body) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const host = target.hostname.replace(/^\[|\]$/g, "");
      if (!insecure && (target.protocol !== "https:" || (isIP(host) !== 0 && !isPublicAddress(host)))) {
        reject(new DeliveryError("connection_refused"));
        return;
      }
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        target,
        {
          method: "POST",
          headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
          timeout: POST_TIMEOUT_MS,
          ...(insecure ? {} : { lookup: publicLookup }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (err) => reject(new DeliveryError(reasonOf(err))));
        },
      );
      req.on("timeout", () => req.destroy(new DeliveryError("timeout")));
      req.on("error", (err) => reject(new DeliveryError(reasonOf(err))));
      req.end(body);
    });
}

/** A Standard Webhooks symmetric secret: `whsec_` and the base64 of 24 to 64 bytes. */
export function isSigningSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return false;
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const size = Buffer.from(encoded, "base64").length;
  return size >= 24 && size <= 64;
}

/** Standard Webhooks `v1` signature over `<id>.<timestamp>.<body>`. */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic over the subscription key `(principal, url, name, arguments)`. */
export function subscriptionId(principal: string, url: string, name: string, args: Record<string, unknown>): string {
  return `sub_${createHash("sha256").update(canonical([principal, url, name, args])).digest("hex").slice(0, 16)}`;
}

interface Subscription {
  id: string;
  principal: string;
  url: string;
  name: string;
  arguments: Record<string, unknown>;
  secret: string;
  /** The secret replaced by a refresh, still signed with until `until`. */
  previous?: { secret: string; until: number };
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
  lastDeliveryAt?: string;
  lastError?: DeliveryErrorReason | null;
  failedSince?: string;
  /** Deliveries given up on since the last refresh. */
  abandoned?: number;
  /** A delivery has succeeded since the last failure, with `abandoned` still to report. */
  recovered?: boolean;
}

export interface SubscribeParams {
  name: string;
  arguments?: Record<string, unknown> | null;
  delivery: { mode?: string; url: string; secret?: string };
  /** Absent asks for the default lifetime, null for no expiry. */
  ttlMs?: number | null;
  /** The client's last persisted position. A new or lapsed subscription replays from it. */
  cursor?: string | null;
  maxAgeMs?: number;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string | null;
  cursor: string;
  truncated: boolean;
  deliveryStatus?: { active: true; lastDeliveryAt: string | null; lastError: DeliveryErrorReason | null; failedSince?: string; abandoned?: number };
}

/** The position of an event in the log. */
const seqOf = (event: EventOccurrence) => Number(event.eventId.slice(event.eventId.lastIndexOf("-") + 1));

/** Reads `FORGE_MCP_WEBHOOK_RETRY_MS`: the waits before the second and later attempts, in ms, separated by commas. */
export function retryDelays(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  const waits = value.split(",").map((part) => Number(part.trim()));
  if (waits.every((wait) => Number.isFinite(wait) && wait >= 0)) return waits;
  console.error(`[forge-mcp-server] FORGE_MCP_WEBHOOK_RETRY_MS is not a list of waits in ms: ${value}`);
  return undefined;
}

export interface WebhookOptions {
  post?: WebhookPost;
  /** JSON file that keeps subscriptions across restarts. It holds the signing secrets. Without it, no-expiry requests get a finite grant. */
  file?: string;
  /** Allow http and non-public callback addresses. */
  insecure?: boolean;
  /** Waits before the second and later attempts of a delivery. */
  retryDelaysMs?: number[];
  now?: () => number;
  /** Receives one line per subscribe, unsubscribe and delivery attempt. Nothing is logged without it. */
  log?: ActivityLog;
}

/**
 * Holds webhook subscriptions and POSTs each emitted event to the ones that match.
 * Cursors are the event log's. The one in a payload or a subscribe result is the SEP's watermark: every event
 * at or before it has been delivered to this subscription or given up on. A new or lapsed subscription that
 * names a cursor gets the retained events after it. A refresh is `truncated` when a delivery was abandoned
 * since the last one, or when its cursor is from before a restart.
 */
export class WebhookHub {
  private readonly subs = new Map<string, Subscription>();
  /** `(principal, url)` pairs that passed the verification handshake, with the time the result lapses. */
  private readonly verified = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Per subscription, the deliveries that have failed and are still being retried. */
  private readonly retrying = new Map<string, number>();
  /** Per subscription, the events not yet delivered or given up on. */
  private readonly pending = new Map<string, Set<EventOccurrence>>();
  /**
   * Per subscription id, the position of the oldest abandoned event that no subscribe result has reported.
   * It outlives the subscription, so a client that resubscribes after a lapse still learns of the gap.
   */
  private readonly unreported = new Map<string, number>();
  private readonly events: EventLog;
  private readonly post: WebhookPost;
  private readonly insecure: boolean;
  private readonly file: string | undefined;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private readonly log: ActivityLog;

  constructor(source: EventLog, opts: WebhookOptions = {}) {
    this.events = source;
    this.insecure = opts.insecure ?? false;
    this.post = opts.post ?? webhookPost({ insecure: this.insecure });
    this.file = opts.file;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1000, 5000, 25_000];
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.load();
    source.onEmit((event) => this.dispatch(event));
  }

  get size(): number {
    return this.subs.size;
  }

  /** Resolves when every delivery started so far has finished or been given up on. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  async subscribe(principal: string, params: SubscribeParams): Promise<SubscribeResult> {
    const { url, secret, mode } = params.delivery;
    if (mode !== undefined && mode !== "webhook") {
      throw new ProtocolError(UNSUPPORTED, "Unsupported", { feature: "deliveryMode", value: mode });
    }
    if (!URL.canParse(url) || (new URL(url).protocol !== "https:" && !this.insecure)) {
      throw new ProtocolError(INVALID_PARAMS, "delivery.url must be an https URL");
    }
    if (!isSigningSecret(secret)) {
      throw new ProtocolError(INVALID_PARAMS, "delivery.secret must be whsec_ followed by the base64 of 24 to 64 bytes");
    }
    const args = params.arguments ?? {};
    const id = subscriptionId(principal, url, params.name, args);
    const now = this.now();
    this.dropExpired(now);
    if (!this.subs.has(id) && this.subs.size >= MAX_SUBSCRIPTIONS) {
      throw new ProtocolError(RESOURCE_EXHAUSTED, "ResourceExhausted", { limit: "subscriptions", max: MAX_SUBSCRIPTIONS });
    }

    const pair = `${principal}\n${url}`;
    if ((this.verified.get(pair) ?? 0) <= now) {
      await this.verify(id, url, secret);
      this.verified.set(pair, now + VERIFIED_FOR_MS);
    }
    // Read after the handshake, during which the subscription can be removed or deliveries can fail.
    const existing = this.subs.get(id);

    const lifetime = this.lifetimeMs(params.ttlMs);
    const expiresAt = lifetime === null ? null : now + lifetime;
    const rotated = existing && existing.secret !== secret ? { secret: existing.secret, until: now + ROTATION_GRACE_MS } : existing?.previous;
    const sub: Subscription = { ...existing, id, principal, url, name: params.name, arguments: args, secret, previous: rotated, expiresAt };
    const status = existing
      ? { active: true as const, lastDeliveryAt: sub.lastDeliveryAt ?? null, lastError: sub.lastError ?? null, ...(sub.failedSince ? { failedSince: sub.failedSince } : {}), ...(sub.abandoned ? { abandoned: sub.abandoned } : {}) }
      : undefined;
    // This refresh reports the abandoned deliveries, so the next one starts clean if delivery has worked since.
    if (sub.recovered && !this.retrying.get(id)) {
      sub.lastError = null;
      delete sub.failedSince;
    }
    delete sub.recovered;
    delete sub.abandoned;
    this.subs.set(id, sub);
    this.save();
    const cursor = params.cursor ?? null;
    const lost = this.unreported.get(id);
    this.unreported.delete(id);
    let truncated = false;
    if (existing) {
      truncated = lost !== undefined || (cursor !== null && !this.events.issued(cursor));
    } else if (cursor !== null) {
      const replay = this.events.poll(params.name, cursor, Number.MAX_SAFE_INTEGER, params.maxAgeMs);
      // An abandoned event at or before the cursor is not in the replay.
      truncated = replay.truncated || (lost !== undefined && Number(cursor.split(":")[1]) >= lost);
      for (const event of replay.events) this.start(sub, event);
    }
    this.log(`webhook ${existing ? "refresh" : "subscribe"} ${id} ${params.name} principal=${principal} expires=${expiresAt === null ? "never" : new Date(expiresAt).toISOString()}`);

    return {
      id,
      refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      cursor: this.watermark(id),
      truncated,
      ...(status ? { deliveryStatus: status } : {}),
    };
  }

  /** Removes the subscription with this key. Returns whether one existed. */
  unsubscribe(principal: string, params: { name: string; arguments?: Record<string, unknown> | null; delivery: { url: string } }): boolean {
    const removed = this.subs.delete(subscriptionId(principal, params.delivery.url, params.name, params.arguments ?? {}));
    if (removed) this.save();
    this.log(`webhook unsubscribe ${params.name} principal=${principal} ${removed ? "removed" : "unknown"}`);
    return removed;
  }

  /** Null is no expiry, which is granted only when subscriptions are kept in a file. */
  private lifetimeMs(ttlMs: number | null | undefined): number | null {
    if (ttlMs === null) return this.file === undefined ? MAX_TTL_MS : null;
    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs ?? DEFAULT_TTL_MS));
  }

  private async verify(id: string, url: string, secret: string): Promise<void> {
    const challenge = randomBytes(24).toString("base64url");
    const fail = (reason: DeliveryErrorReason) => new ProtocolError(CALLBACK_ENDPOINT_ERROR, "CallbackEndpointError", { reason });
    let response: { status: number; body: string };
    try {
      const body = JSON.stringify({ type: "verification", challenge });
      response = await this.post(url, this.headers(id, `msg_verification_${randomBytes(12).toString("base64url")}`, [secret], body), body);
    } catch (err) {
      throw fail(reasonOf(err));
    }
    if (response.status >= 500) throw fail("http_5xx");
    if (response.status < 200 || response.status >= 300) throw fail("http_4xx");
    let echoed: unknown;
    try {
      echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    const expected = Buffer.from(challenge);
    const given = Buffer.from(typeof echoed === "string" ? echoed : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail("challenge_failed");
  }

  private headers(subscription: string, id: string, secrets: string[], body: string): Record<string, string> {
    const timestamp = Math.floor(this.now() / 1000);
    return {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": secrets.map((s) => sign(s, id, timestamp, body)).join(" "),
      "x-mcp-subscription-id": subscription,
    };
  }

  private dispatch(event: EventOccurrence): void {
    this.dropExpired(this.now());
    const oversize = Buffer.byteLength(JSON.stringify({ ...event, cursor: this.events.head() })) > MAX_BODY_BYTES;
    if (oversize) console.error(`[forge-mcp-server] ${event.name} ${event.eventId} is over 256 KiB and was not delivered by webhook`);
    for (const sub of this.subs.values()) {
      if (sub.name !== event.name) continue;
      if (oversize) {
        this.abandon(sub, event);
        continue;
      }
      this.start(sub, event);
    }
  }

  /** Starts the delivery of `event` to `sub`, unless one is already under way. */
  private start(sub: Subscription, event: EventOccurrence): void {
    const pending = this.pending.get(sub.id) ?? new Set();
    if (pending.has(event)) return;
    this.pending.set(sub.id, pending.add(event));
    const delivery = this.deliver(sub, event).finally(() => {
      pending.delete(event);
      if (pending.size === 0 && this.pending.get(sub.id) === pending) this.pending.delete(sub.id);
      this.inFlight.delete(delivery);
    });
    this.inFlight.add(delivery);
  }

  private abandon(sub: Subscription, event: EventOccurrence): void {
    sub.abandoned = (sub.abandoned ?? 0) + 1;
    this.unreported.set(sub.id, Math.min(this.unreported.get(sub.id) ?? Infinity, seqOf(event)));
  }

  /** The position at or before which every event has been delivered to this subscription or given up on. */
  private watermark(id: string, sending?: EventOccurrence): string {
    let oldest: EventOccurrence | undefined;
    // A replay can add events older than one already under way, so the set is not in log order.
    for (const event of this.pending.get(id) ?? []) if (!oldest || seqOf(event) < seqOf(oldest)) oldest = event;
    if (oldest && oldest !== sending) return this.events.cursorBefore(oldest);
    return sending ? this.events.cursorAfter(sending) : this.events.head();
  }

  /**
   * One event to one subscription. Each attempt is signed again. 410 and 413 are not retried.
   * A delivery given up on is counted in `abandoned`, except after 410, which the receiver sends to refuse an event.
   */
  private async deliver(sub: Subscription, event: EventOccurrence): Promise<void> {
    const { name, eventId } = event;
    const id = sub.id;
    let failed = false;
    const retried = (by: number) => this.retrying.set(id, (this.retrying.get(id) ?? 0) + by);
    try {
      for (let attempt = 0; ; attempt++) {
        // A refresh replaces the stored object, so read it again before and after each attempt.
        const current = this.subs.get(id);
        if (!current || (current.expiresAt !== null && current.expiresAt <= this.now())) return;
        const secrets = [current.secret, ...(current.previous && current.previous.until > this.now() ? [current.previous.secret] : [])];
        let error: DeliveryErrorReason;
        let status: number | undefined;
        const body = JSON.stringify({ ...event, cursor: this.watermark(id, event) });
        const started = Date.now();
        const note = (result: string | number) => this.log(`webhook delivery ${name} ${eventId} to ${id} attempt ${attempt + 1}: ${result} in ${Date.now() - started} ms`);
        try {
          ({ status } = await this.post(current.url, this.headers(id, eventId, secrets, body), body));
          note(status);
          error = status >= 500 ? "http_5xx" : "http_4xx";
        } catch (err) {
          error = reasonOf(err);
          note(error);
        }
        const latest = this.subs.get(id);
        if (!latest) return;
        if (status !== undefined && status >= 200 && status < 300) {
          if (failed) retried(-1);
          failed = false;
          latest.lastDeliveryAt = new Date(this.now()).toISOString();
          // An earlier event may still be failing, or lost and not yet reported by a refresh.
          if (this.retrying.get(id)) return;
          if (latest.abandoned) {
            latest.recovered = true;
          } else {
            latest.lastError = null;
            delete latest.failedSince;
          }
          return;
        }
        if (!failed) retried(1);
        failed = true;
        latest.lastError = error;
        delete latest.recovered;
        latest.failedSince ??= new Date(this.now()).toISOString();
        const wait = this.retryDelaysMs[attempt];
        if (status === 410 || status === 413 || wait === undefined) {
          if (status !== 410) this.abandon(latest, event);
          console.error(`[forge-mcp-server] webhook delivery of ${eventId} to ${id} failed: ${error}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, wait).unref());
      }
    } finally {
      if (failed) retried(-1);
      if (!this.retrying.get(id)) this.retrying.delete(id);
    }
  }

  private dropExpired(now: number): void {
    let dropped = false;
    for (const [id, sub] of this.subs) {
      if (sub.expiresAt !== null && sub.expiresAt <= now) dropped = this.subs.delete(id) || dropped;
    }
    if (dropped) this.save();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as { subscriptions?: Subscription[]; verified?: [string, number][] };
      for (const sub of stored.subscriptions ?? []) this.subs.set(sub.id, sub);
      for (const [pair, until] of stored.verified ?? []) this.verified.set(pair, until);
    } catch (err) {
      console.error(`[forge-mcp-server] could not read ${this.file}: ${(err as Error).message}`);
    }
  }

  private save(): void {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ subscriptions: [...this.subs.values()], verified: [...this.verified] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
