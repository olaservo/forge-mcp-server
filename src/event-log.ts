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
  private readonly firstPollListeners: ((name: string) => void)[] = [];
  private seq = 0;

  constructor(private readonly capacity = 1000) {}

  /** Calls `listener` with each event as it is emitted. */
  onEmit(listener: (event: EventOccurrence) => void): void {
    this.listeners.push(listener);
  }

  /** Calls `listener` after a poll without a cursor, which is a client starting to follow `name`. */
  onFirstPoll(listener: (name: string) => void): void {
    this.firstPollListeners.push(listener);
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
    if (cursor == null) {
      // After this poll's cursor is taken, so an event a listener emits reaches the new client
      queueMicrotask(() => this.firstPollListeners.forEach((listener) => listener(name)));
      return { ...fresh, truncated: false };
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
