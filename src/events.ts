import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { EventLog } from "./event-log.js";
import type { ActivityLog } from "./log.js";
import { EVENT_TYPES } from "./seat-events.js";
import { FORBIDDEN, INVALID_PARAMS, NOT_FOUND, UNSUPPORTED, type WebhookHub } from "./webhooks.js";

/**
 * MCP Events (SEP-3415, Final, https://modelcontextprotocol.io/seps/3415-events-extension), poll and webhook delivery.
 * The `events/*` methods are registered as custom methods because SDK 2.4.0 has no events support.
 */

const PollParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().nullish(),
  maxAgeMs: z.number().optional(),
  maxEvents: z.number().int().positive().optional(),
});

const SubscribeParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullish(),
  delivery: z.looseObject({ mode: z.string().optional(), url: z.string(), secret: z.string().optional() }),
  ttlMs: z.number().nullish(),
});

export interface WebhookAccess {
  hub: WebhookHub;
  /** The authenticated caller of this request. Webhook subscriptions are refused without one. */
  principal?: string;
}

/** Throws unless the event exists and takes these arguments. Neither event type has any. */
function checkEvent(name: string, args?: Record<string, unknown> | null): void {
  if (!EVENT_TYPES.some((e) => e.name === name)) throw new ProtocolError(NOT_FOUND, "NotFound", { kind: "event" });
  if (args && Object.keys(args).length > 0) throw new ProtocolError(INVALID_PARAMS, `${name} takes no arguments`);
}

/** The hub and principal for a webhook request, or the error the SEP gives for a server or caller that has none. */
function webhookCaller(webhooks: WebhookAccess | undefined): { hub: WebhookHub; principal: string } {
  if (!webhooks) throw new ProtocolError(UNSUPPORTED, "Unsupported", { feature: "deliveryMode", value: "webhook" });
  if (!webhooks.principal) throw new ProtocolError(FORBIDDEN, "Forbidden", { reason: "Webhook subscriptions need an authenticated caller" });
  return { hub: webhooks.hub, principal: webhooks.principal };
}

export function registerEvents(server: McpServer, log: EventLog, webhooks?: WebhookAccess, activity?: ActivityLog): void {
  const delivery = webhooks ? ["poll", "webhook"] : ["poll"];
  const events = EVENT_TYPES.map((e) => ({ ...e, delivery }));
  server.server.setRequestHandler("events/list", { params: z.looseObject({}).optional() }, async () => ({ resultType: "complete", events }));
  server.server.setRequestHandler("events/poll", { params: PollParams }, async (params) => {
    checkEvent(params.name);
    const result = log.poll(params.name, params.cursor, params.maxEvents, params.maxAgeMs);
    if (result.events.length > 0) activity?.(`poll ${params.name} returned ${result.events.map((e) => e.eventId).join(" ")}`);
    return { resultType: "complete", ...result };
  });
  server.server.setRequestHandler("events/subscribe", { params: SubscribeParams }, async (params) => {
    const { hub, principal } = webhookCaller(webhooks);
    checkEvent(params.name, params.arguments);
    return { resultType: "complete", ...(await hub.subscribe(principal, params)) };
  });
  server.server.setRequestHandler("events/unsubscribe", { params: SubscribeParams }, async (params) => {
    const { hub, principal } = webhookCaller(webhooks);
    hub.unsubscribe(principal, params);
    return { resultType: "complete" };
  });
}
