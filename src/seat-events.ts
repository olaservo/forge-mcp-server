import type { z } from "zod";
import type { EventLog, EventOccurrence } from "./event-log.js";
import type { Status } from "./schemas.js";

export const YOUR_MOVE = "forge.your_move";
export const CHAT = "forge.chat";

/** The bridge's `/status` payload. */
export type SeatStatus = z.infer<typeof Status>;

type Move = { key: string; data: Record<string, unknown> };

function gameOver(game: NonNullable<SeatStatus["game"]>, revision: SeatStatus["revision"]): Move {
  const data = { kind: "game_over", prompt: `Game over. Winner: ${game.winner ?? ""}`, revision, turn: game.turn, phase: game.phase };
  return { key: `game_over:${game.turn}:${game.winner}`, data };
}

/**
 * What the seat is being asked to do, or undefined when it is waiting on someone else. `key` identifies the ask.
 * A bridge up to 0.1.2 sends no `waiting` and no `promptCount`, and the prompt's text stands in for both.
 */
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
    const waiting = game.waiting ?? prompt.includes("Waiting for");
    // An empty prompt is the gap between two inputs, not an ask.
    if ((game.buttons?.okEnabled || game.buttons?.cancelEnabled) && prompt.trim() !== "" && !waiting) {
      // The key leaves the phase out: the host updates the phase before the prompt, so keying on both
      // reported each priority twice, a second apart, the first time with the previous prompt's text.
      return { key: `priority:${game.promptCount ?? `${game.turn}:${prompt}`}`, data: { kind: "priority", prompt, ...at } };
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
  // A seat that sits unready has its name, portrait and deck still to set, for example after auto-join without a deck.
  const mySlot = status.lobby?.mySlot ?? -1;
  const seat = status.lobby?.slots?.find((s, i) => (s.index ?? i) === mySlot);
  const drafting = (draft?.packNumber ?? 0) > 0 && !draft?.poolReceived;
  if (seat && seat.ready === false && !drafting) {
    const prompt = "You are seated in the lobby and not ready. Set your name, portrait and deck, then ready up.";
    return { key: "lobby", data: { kind: "lobby", prompt, revision } };
  }
  return undefined;
}

/** Emits `forge.your_move` each time the seat's pending ask changes to a new one. */
export class MoveTracker {
  private last: string | undefined;
  /** The finished game already reported. Its result stays in the status under later asks. */
  private reported: string | undefined;
  private replayed: { key: string; at: number } | undefined;

  constructor(private readonly log: EventLog) {}

  observe(status: SeatStatus): EventOccurrence | undefined {
    // A game in progress means the reported result belongs to an earlier game. The next result is then
    // new, even when it ends on the same turn with the same winner.
    if (status.game?.inGame && !status.game.gameOver && !status.game.finished) this.reported = undefined;
    const pending = pendingMove(status);
    const move = pending?.data.kind === "game_over" && pending.key === this.reported ? undefined : pending;
    const changed = move !== undefined && move.key !== this.last;
    this.last = move?.key;
    if (changed && move.data.kind === "game_over") this.reported = move.key;
    return changed ? this.log.emit(YOUR_MOVE, move.data) : undefined;
  }

  /**
   * Emits the ask that is pending now, for a client that started following after it was first reported.
   * One client can open several polls as it starts (fast-agent opened five within four seconds on 2026-11-15),
   * so the same ask is replayed once per `quietMs`.
   */
  replay(status: SeatStatus, quietMs = 15_000): EventOccurrence | undefined {
    const move = pendingMove(status);
    if (!move || (move.data.kind === "game_over" && move.key === this.reported)) return undefined;
    const now = Date.now();
    if (this.replayed?.key === move.key && now - this.replayed.at < quietMs) return undefined;
    this.replayed = { key: move.key, at: now };
    this.last = move.key;
    if (move.data.kind === "game_over") this.reported = move.key;
    return this.log.emit(YOUR_MOVE, move.data);
  }
}

/** The lines of `now` after its overlap with `before`. Both are the bridge's last 20 chat lines. For a bridge up to 0.1.2, which sends no `chatCount`. */
function newLines(before: string[], now: string[]): string[] {
  let dropped = 0;
  while (dropped < before.length && !before.slice(dropped).every((line, i) => now[i] === line)) dropped++;
  return now.slice(before.length - dropped);
}

/** Emits `forge.chat` for each new chat line from another player. Lines from the server and from our own seat are skipped. */
export class ChatTracker {
  private last: string[] | undefined;
  /** The bridge's count of chat lines at the last status. */
  private count: number | undefined;

  constructor(private readonly log: EventLog) {}

  /** The lines that arrived since the last status. `chat` is the last 20 lines and `chatCount` counts them all. */
  private added(status: SeatStatus): string[] {
    const lines = status.chat ?? [];
    const prev = this.last;
    const seen = this.count;
    this.last = lines;
    this.count = status.chatCount ?? undefined;
    if (prev === undefined) return [];
    if (this.count === undefined || seen === undefined) return newLines(prev, lines);
    return this.count > seen ? lines.slice(-(this.count - seen)) : [];
  }

  observe(status: SeatStatus): EventOccurrence[] {
    const added = this.added(status);
    const me = status.connection?.name;
    const others = new Set((status.lobby?.slots ?? []).map((s) => s.name).filter((n) => n && n !== me));
    const emitted: EventOccurrence[] = [];
    for (const line of added) {
      const at = line.indexOf(": ");
      const from = at > 0 ? line.slice(0, at) : "";
      if (others.has(from)) emitted.push(this.log.emit(CHAT, { from, text: line.slice(at + 2), revision: status.revision }));
    }
    return emitted;
  }
}

const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false };

export const EVENT_TYPES = [
  {
    name: YOUR_MOVE,
    description:
      "Fires when the Forge seat is asked to act: a seat in the lobby that is not ready yet, a draft pick, a priority prompt, a choice dialog, or the end of a game. " +
      "The payload is a summary. Read the full state with forge_status before acting.",
    inputSchema: NO_ARGUMENTS,
    payloadSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lobby", "draft_pick", "priority", "decision", "game_over"] },
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
