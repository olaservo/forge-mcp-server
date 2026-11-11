import { randomUUID } from "node:crypto";
import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * MCP Events (SEP-3415, Accepted 2026-11-11, read at f77a5fe), poll delivery only.
 * `events/list` and `events/poll` are registered as custom methods because SDK 2.4.0 has no events support.
 */
export const YOUR_MOVE = "forge.your_move";
export const CHAT = "forge.chat";

/** `-32023 NotFound`. The SEP is accepted; the number is final once the SEP merges with no other code allocated before it. */
const NOT_FOUND = -32023;
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
  private seq = 0;

  constructor(private readonly capacity = 1000) {}

  emit(name: string, data: Record<string, unknown>): EventOccurrence {
    const seq = ++this.seq;
    const event = { eventId: `${this.epoch}-${seq}`, name, timestamp: new Date().toISOString(), data };
    this.entries.push({ seq, event });
    if (this.entries.length > this.capacity) this.entries.shift();
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
    pendingDecision?: { id?: number | null; kind?: string | null; prompt?: string | null } | null;
  } | null;
}

/** What the seat is being asked to do, or undefined when it is waiting on someone else. `key` identifies the ask. */
export function pendingMove(status: SeatStatus): { key: string; data: Record<string, unknown> } | undefined {
  const { draft, game, revision } = status;
  if (game?.inGame) {
    const at = { revision, turn: game.turn, phase: game.phase };
    if (game.gameOver || game.finished) {
      return { key: `game_over:${game.turn}:${game.winner}`, data: { kind: "game_over", prompt: `Game over. Winner: ${game.winner ?? ""}`, ...at } };
    }
    const decision = game.pendingDecision;
    if (decision) {
      return { key: `decision:${decision.id}`, data: { kind: "decision", prompt: decision.prompt, decisionKind: decision.kind, ...at } };
    }
    const prompt = game.prompt ?? "";
    // An empty prompt is the gap between two inputs, not an ask.
    if ((game.buttons?.okEnabled || game.buttons?.cancelEnabled) && prompt.trim() !== "" && !prompt.includes("Waiting for")) {
      return { key: `priority:${game.turn}:${game.phase}:${prompt}`, data: { kind: "priority", prompt, ...at } };
    }
    return undefined;
  }
  if (draft?.pickPending) {
    const prompt = `Pack ${draft.packNumber}, pick ${draft.pickNumber}`;
    return { key: `draft_pick:${draft.packNumber}:${draft.pickNumber}`, data: { kind: "draft_pick", prompt, revision } };
  }
  // The host can return the seat to the lobby as the game ends, so the result arrives with inGame false.
  // It stays in the status afterwards. The key does not change, so it fires once.
  if (game?.gameOver || game?.finished) {
    const data = { kind: "game_over", prompt: `Game over. Winner: ${game.winner ?? ""}`, revision, turn: game.turn, phase: game.phase };
    return { key: `game_over:${game.turn}:${game.winner}`, data };
  }
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

/**
 * Emits `forge.chat` for each new chat line from another player. The bridge reports the last 20 lines,
 * so new lines are the ones after the overlap with the previous report. Lines from the server and from
 * our own seat are skipped.
 */
export class ChatTracker {
  private last: string[] | undefined;

  constructor(private readonly log: EventLog) {}

  observe(status: SeatStatus): EventOccurrence[] {
    const lines = status.chat ?? [];
    const prev = this.last;
    this.last = lines;
    if (prev === undefined) return [];
    let shift = 0;
    while (shift < prev.length && !prev.slice(shift).every((line, i) => lines[i] === line)) shift++;
    const me = status.connection?.name;
    const others = new Set((status.lobby?.slots ?? []).map((s) => s.name).filter((n) => n && n !== me));
    const emitted: EventOccurrence[] = [];
    for (const line of lines.slice(prev.length - shift)) {
      const at = line.indexOf(": ");
      const from = at > 0 ? line.slice(0, at) : "";
      if (others.has(from)) emitted.push(this.log.emit(CHAT, { from, text: line.slice(at + 2), revision: status.revision }));
    }
    return emitted;
  }
}

const EVENT_TYPES = [
  {
    name: YOUR_MOVE,
    description:
      "Fires when the Forge seat is asked to act: a draft pick, a priority prompt, a choice dialog, or the end of a game. " +
      "The payload is a summary. Read the full state with forge_status before acting.",
    delivery: ["poll"],
    inputSchema: { type: "object", properties: {} },
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
    delivery: ["poll"],
    inputSchema: { type: "object", properties: {} },
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

export function registerEvents(server: McpServer, log: EventLog): void {
  server.server.setRequestHandler("events/list", { params: z.looseObject({}).optional() }, async () => ({ resultType: "complete", events: EVENT_TYPES }));
  server.server.setRequestHandler("events/poll", { params: PollParams }, async (params) => {
    if (!EVENT_TYPES.some((e) => e.name === params.name)) {
      throw new ProtocolError(NOT_FOUND, "NotFound", { kind: "event" });
    }
    return { resultType: "complete", ...log.poll(params.name, params.cursor, params.maxEvents, params.maxAgeMs) };
  });
}
