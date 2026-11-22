import { randomUUID } from "node:crypto";

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
  private readonly pendingSources = new Map<string, () => EventOccurrence | undefined>();
  private seq = 0;

  constructor(private readonly capacity = 1000) {}

  /** What every event id of this process starts with. */
  get source(): string {
    return this.epoch;
  }

  /** Calls `listener` with each event as it is emitted. Returns a function that stops it. */
  onEmit(listener: (event: EventOccurrence) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /** The cursor after the newest event. */
  head(): string {
    return `${this.epoch}:${this.seq}`;
  }

  /** The cursor after `event`. */
  cursorAfter(event: EventOccurrence): string {
    return event.eventId.replace(/-(\d+)$/, ":$1");
  }

  /** The cursor before `event`. */
  cursorBefore(event: EventOccurrence): string {
    return event.eventId.replace(/-(\d+)$/, (_, seq) => `:${Number(seq) - 1}`);
  }

  /** Whether `cursor` is a position in this process's log, retained or not. */
  issued(cursor: string): boolean {
    const [epoch, raw] = cursor.split(":");
    const seq = Number(raw);
    return epoch === this.epoch && Number.isInteger(seq) && seq >= 0 && seq <= this.seq;
  }

  /** Sets where `pending(name)` reads from. */
  onPending(name: string, source: () => EventOccurrence | undefined): void {
    this.pendingSources.set(name, source);
  }

  /** The event that reported what is still pending for `name`, for a client that starts following after it was emitted. */
  pending(name: string): EventOccurrence | undefined {
    return this.pendingSources.get(name)?.();
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
    const head = this.head();
    // Held to the range a Date can represent
    const floor = maxAgeMs === undefined ? "" : new Date(Math.min(8.64e15, Math.max(0, Date.now() - maxAgeMs))).toISOString();
    const fresh = { events: [], cursor: head, hasMore: false, nextPollMs: POLL_MS };
    if (cursor == null) {
      // A client starting to follow is given the ask still pending, and no other client is. It keeps its eventId,
      // so a client that has it drops it. The timestamp is now: a client's maxAgeMs, and the mcp-events mod's check
      // against its last state read, would otherwise drop an ask that has waited a while.
      const ask = this.pending(name);
      return { ...fresh, events: ask ? [{ ...ask, timestamp: new Date().toISOString() }] : [], truncated: false };
    }

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
