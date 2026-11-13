import { randomUUID } from "node:crypto";
import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FORBIDDEN, INVALID_PARAMS, NOT_FOUND, UNSUPPORTED, type WebhookHub } from "./webhooks.js";

/**
 * MCP Events (SEP-3415, Accepted 2026-11-11, read at f77a5fe), poll and webhook delivery.
 * The `events/*` methods are registered as custom methods because SDK 2.4.0 has no events support.
 */
export const YOUR_MOVE = "forge.your_move";
export const CHAT = "forge.chat";

const POLL_MS = 1000;

export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface PollResult {
  events: EventOccurrence[];
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}

/**
 * In-memory log of emitted events. Cursors are `<epoch>:<seq>` and the epoch is per process,
 * so a cursor from before a restart, or older than the retained window, polls as `truncated`.
 */
export class EventLog {
  private readonly epoch = randomUUID().slice(0, 8);
  private readonly entries: { seq: number; event: EventOccurrence }[] = [];
  private readonly listeners: ((event: EventOccurrence) => void)[] = [];
  private seq = 0;

  constructor(private readonly capacity = 1000) {}

  /** Calls `listener` with each event as it is emitted. */
  onEmit(listener: (event: EventOccurrence) => void): void {
    this.listeners.push(listener);
  }

  emit(name: string, data: Record<string, unknown>): EventOccurrence {
    const seq = ++this.seq;
    const event = { eventId: `${this.epoch}-${seq}`, name, timestamp: new Date().toISOString(), data };
    this.entries.push({ seq, event });
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  poll(name: string, cursor: string | null | undefined, maxEvents = 100, maxAgeMs?: number): PollResult {
    const head = `${this.epoch}:${this.seq}`;
    const floor = maxAgeMs === undefined ? "" : new Date(Date.now() - maxAgeMs).toISOString();
    const fresh = { events: [], cursor: head, hasMore: false, nextPollMs: POLL_MS };
    if (cursor == null) return { ...fresh, truncated: false };

    const [epoch, raw] = cursor.split(":");
    const from = Number(raw);
    const oldest = this.entries[0]?.seq ?? this.seq + 1;
    if (epoch !== this.epoch || !Number.isInteger(from) || from > this.seq || from < oldest - 1) {
      return { ...fresh, truncated: true };
    }
    const since = this.entries.filter((e) => e.seq > from && e.event.name === name);
    const pending = since.filter((e) => e.event.timestamp >= floor);
    const batch = pending.slice(0, maxEvents);
    const hasMore = pending.length > batch.length;
    return {
      events: batch.map((e) => e.event),
      cursor: hasMore ? `${this.epoch}:${batch[batch.length - 1]!.seq}` : head,
      truncated: pending.length < since.length,
      hasMore,
      nextPollMs: POLL_MS,
    };
  }
}

interface SeatStatus {
  revision?: number;
  chat?: string[] | null;
  connection?: { name?: string | null } | null;
  lobby?: { slots?: { name?: string | null }[] | null } | null;
  draft?: { pickPending?: boolean | null; packNumber?: number | null; pickNumber?: number | null } | null;
  game?: {
    inGame?: boolean | null;
    finished?: boolean | null;
    gameOver?: boolean | null;
    winner?: string | null;
    prompt?: string | null;
    turn?: number | null;
    phase?: string | null;
    buttons?: { okEnabled?: boolean | null; cancelEnabled?: boolean | null } | null;
    /** Whether the seat holds priority. Absent from bridges older than forge-agent-bridge 0.1.0 of 2026-11-11. */
    hasPriority?: boolean | null;
    pendingDecision?: { id?: number | null; kind?: string | null; prompt?: string | null } | null;
  } | null;
}

type Move = { key: string; data: Record<string, unknown> };

function gameOver(game: NonNullable<SeatStatus["game"]>, revision: number | undefined): Move {
  const data = { kind: "game_over", prompt: `Game over. Winner: ${game.winner ?? ""}`, revision, turn: game.turn, phase: game.phase };
  return { key: `game_over:${game.turn}:${game.winner}`, data };
}

/** What the seat is being asked to do, or undefined when it is waiting on someone else. `key` identifies the ask. */
export function pendingMove(status: SeatStatus): Move | undefined {
  const { draft, game, revision } = status;
  if (game?.inGame) {
    if (game.gameOver || game.finished) return gameOver(game, revision);
    const at = { revision, turn: game.turn, phase: game.phase };
    const decision = game.pendingDecision;
    if (decision) {
      return { key: `decision:${decision.id}`, data: { kind: "decision", prompt: decision.prompt, decisionKind: decision.kind, ...at } };
    }
    const prompt = game.prompt ?? "";
    // When the host auto-passes for the seat it sends no new prompt, so the last "Priority: ..." text stays up.
    if (prompt.startsWith("Priority:") && game.hasPriority === false) return undefined;
    // An empty prompt is the gap between two inputs, not an ask.
    if ((game.buttons?.okEnabled || game.buttons?.cancelEnabled) && prompt.trim() !== "" && !prompt.includes("Waiting for")) {
      // The key leaves the phase out: the host updates the phase before the prompt, so keying on both
      // reported each priority twice, a second apart, the first time with the previous prompt's text.
      return { key: `priority:${game.turn}:${prompt}`, data: { kind: "priority", prompt, ...at } };
    }
    return undefined;
  }
  if (draft?.pickPending) {
    const prompt = `Pack ${draft.packNumber}, pick ${draft.pickNumber}`;
    return { key: `draft_pick:${draft.packNumber}:${draft.pickNumber}`, data: { kind: "draft_pick", prompt, revision } };
  }
  // The host can return the seat to the lobby as the game ends, so the result arrives with inGame false.
  // It stays in the status afterwards. The key does not change, so it fires once.
  if (game?.gameOver || game?.finished) return gameOver(game, revision);
  return undefined;
}

/** Emits `forge.your_move` each time the seat's pending ask changes to a new one. */
export class MoveTracker {
  private last: string | undefined;
  /** The finished game already reported. Its result stays in the status under later asks. */
  private reported: string | undefined;

  constructor(private readonly log: EventLog) {}

  observe(status: SeatStatus): EventOccurrence | undefined {
    const pending = pendingMove(status);
    const move = pending?.data.kind === "game_over" && pending.key === this.reported ? undefined : pending;
    const changed = move !== undefined && move.key !== this.last;
    this.last = move?.key;
    if (changed && move.data.kind === "game_over") this.reported = move.key;
    return changed ? this.log.emit(YOUR_MOVE, move.data) : undefined;
  }
}

/** The lines of `now` after its overlap with `before`. Both are the bridge's last 20 chat lines. */
function newLines(before: string[], now: string[]): string[] {
  let dropped = 0;
  while (dropped < before.length && !before.slice(dropped).every((line, i) => now[i] === line)) dropped++;
  return now.slice(before.length - dropped);
}

/** Emits `forge.chat` for each new chat line from another player. Lines from the server and from our own seat are skipped. */
export class ChatTracker {
  private last: string[] | undefined;

  constructor(private readonly log: EventLog) {}

  observe(status: SeatStatus): EventOccurrence[] {
    const lines = status.chat ?? [];
    const prev = this.last;
    this.last = lines;
    if (prev === undefined) return [];
    const me = status.connection?.name;
    const others = new Set((status.lobby?.slots ?? []).map((s) => s.name).filter((n) => n && n !== me));
    const emitted: EventOccurrence[] = [];
    for (const line of newLines(prev, lines)) {
      const at = line.indexOf(": ");
      const from = at > 0 ? line.slice(0, at) : "";
      if (others.has(from)) emitted.push(this.log.emit(CHAT, { from, text: line.slice(at + 2), revision: status.revision }));
    }
    return emitted;
  }
}

const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false };

const EVENT_TYPES = [
  {
    name: YOUR_MOVE,
    description:
      "Fires when the Forge seat is asked to act: a draft pick, a priority prompt, a choice dialog, or the end of a game. " +
      "The payload is a summary. Read the full state with forge_status before acting.",
    inputSchema: NO_ARGUMENTS,
    payloadSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["draft_pick", "priority", "decision", "game_over"] },
        prompt: { type: "string" },
        decisionKind: { type: "string" },
        revision: { type: "integer", description: "Bridge revision the ask was seen at" },
        turn: { type: "integer" },
        phase: { type: "string" },
      },
      required: ["kind"],
    },
  },
  {
    name: CHAT,
    description: "Fires when another player says something in the lobby or game chat. Answer with forge_chat.",
    inputSchema: NO_ARGUMENTS,
    payloadSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        text: { type: "string" },
        revision: { type: "integer", description: "Bridge revision the line was seen at" },
      },
      required: ["from", "text"],
    },
  },
];

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

export function registerEvents(server: McpServer, log: EventLog, webhooks?: WebhookAccess, activity?: (line: string) => void): void {
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
