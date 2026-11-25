import type { z } from "zod";
import type { EventLog, EventOccurrence } from "./event-log.js";
import type { Status } from "./schemas.js";

export const YOUR_MOVE = "forge.your_move";
export const CHAT = "forge.chat";

/** The bridge's `/status` payload. */
export type SeatStatus = z.infer<typeof Status>;

type Move = { key: string; data: Record<string, unknown> };

function gameOver(game: NonNullable<SeatStatus["game"]>, revision: SeatStatus["revision"]): Move {
  // Bridge 0.1.11 says where the match stands. Without it the seat cannot tell whether another game follows.
  const match = game.match;
  const standing = match ? { matchOver: match.over, score: match.wins, ...(match.sideboarding === true && { sideboarding: true }) } : {};
  const data = { kind: "game_over", prompt: `Game over. Winner: ${game.winner ?? ""}`, revision, turn: game.turn, phase: game.phase, ...standing };
  return { key: `game_over:${match?.game ?? ""}:${game.turn}:${game.winner}`, data };
}

/**
 * What the seat is being asked to do, or undefined when it is waiting on someone else. `key` identifies the ask.
 * `awaited` is the `promptCount` of an earlier status that had the seat waiting.
 * `promptCount`, `waiting` and `chatCount` need forge-agent-bridge 0.1.3.
 */
export function pendingMove(status: SeatStatus, awaited?: number): Move | undefined {
  const { draft, game, revision } = status;
  if (game?.inGame) {
    if (game.gameOver || game.finished) return gameOver(game, revision);
    const at = { revision, turn: game.turn, phase: game.phase };
    const decision = game.pendingDecision;
    if (decision) {
      return { key: `decision:${decision.id}`, data: { kind: "decision", prompt: decision.prompt, decisionKind: decision.kind, ...at } };
    }
    const prompt = game.prompt ?? "";
    // When the host auto-passes for the seat it sends no new prompt, so the last priority prompt stays up.
    // Bridge 0.1.4 marks that prompt. Before it, the English text is matched.
    const priorityPrompt = game.priorityPrompt ?? prompt.startsWith("Priority:");
    if (priorityPrompt && game.hasPriority === false) return undefined;
    // Forge sends the buttons of the next input before its prompt, and the buttons clear `waiting`. Until the
    // prompt arrives the count is the one the seat waited at, and the text is still "Waiting for ...".
    if (awaited !== undefined && game.promptCount === awaited) return undefined;
    // A prompt with no button enabled is answered by selecting a card or a player, as a target that must be
    // chosen is. Only the bridge's `waiting` flag tells it from the prompt shown while another player acts.
    const answerable = game.buttons?.okEnabled || game.buttons?.cancelEnabled || game.waiting === false;
    // An empty prompt is the gap between two inputs, not an ask.
    if (answerable && prompt.trim() !== "" && !game.waiting) {
      // The bridge counts each prompt the host sends, so the same text twice in a turn is two asks.
      return { key: `priority:${game.promptCount}`, data: { kind: "priority", prompt, ...at } };
    }
    return undefined;
  }
  if (draft?.pickPending) {
    const clock = typeof draft.secondsLeft === "number" ? { secondsLeft: draft.secondsLeft } : {};
    const prompt = `Pack ${draft.packNumber}, pick ${draft.pickNumber}` + ("secondsLeft" in clock ? `, ${clock.secondsLeft} s on the clock` : "");
    return { key: `draft_pick:${draft.packNumber}:${draft.pickNumber}`, data: { kind: "draft_pick", prompt, revision, ...clock } };
  }
  // The host can return the seat to the lobby as the game ends, so the result arrives with inGame false.
  // It stays in the status afterwards. The key does not change, so it fires once.
  if (game?.gameOver || game?.finished) return gameOver(game, revision);
  // A seat that sits unready has its name, portrait and deck still to set, for example after auto-join without a deck.
  const mySlot = status.lobby?.mySlot ?? -1;
  const seat = status.lobby?.slots?.find((s, i) => (s.index ?? i) === mySlot);
  const lobby = status.lobby;
  // The pool of a draft or sealed event is not a deck. The seat keeps its ready flag from before the draft,
  // so nothing else asks it to build one. `myDeck` needs forge-agent-bridge 0.1.6.
  const poolEvent = draft?.poolReceived ? draft.poolEventId : undefined;
  const poolIsForThisLobby = poolEvent != null && lobby?.limitedMode === true && (lobby.activeEventId === poolEvent || lobby.event?.eventId === poolEvent);
  if (seat && poolIsForThisLobby && !((lobby?.myDeck?.mainSize ?? 0) > 0)) {
    const prompt = "Your pool has arrived. Build a deck of at least 40 cards from it with forge_draft_deck. Its answer says whether you are ready.";
    return { key: `deck:${poolEvent}`, data: { kind: "deck", prompt, revision } };
  }
  const drafting = (draft?.packNumber ?? 0) > 0 && !draft?.poolReceived;
  if (seat && seat.ready === false && !drafting) {
    // Before a draft or sealed event starts there is no pool to build from, and the host cannot start until every seat is ready.
    const beforeEvent = lobby?.limitedMode === true && lobby.event?.phase === "LOBBY_GATHER" && lobby.event.eventId !== poolEvent;
    // With the deck from the pool in the slot, the ready flag is all that is missing.
    const built = poolIsForThisLobby;
    const prompt = beforeEvent
      ? "You are seated in a Limited lobby with an event set up and you are not ready. Ready up so the host can start it. No deck is needed yet."
      : built
        ? "Your deck for the Limited match is set and you are not ready. Ready up with forge_lobby_ready."
        : "You are seated in the lobby and not ready. Set your name, portrait and deck, then ready up.";
    return { key: beforeEvent ? `lobby:${lobby.event?.eventId}` : "lobby", data: { kind: "lobby", prompt, revision } };
  }
  return undefined;
}

/** Emits `forge.your_move` each time the seat's pending ask changes to a new one. */
export class MoveTracker {
  private last: string | undefined;
  /** The finished game already reported. Its result stays in the status under later asks. */
  private reported: string | undefined;
  /** The event that last reported the ask in `last`. */
  private lastEvent: EventOccurrence | undefined;
  /** The `promptCount` the seat was last seen waiting at, while the count stays there. */
  private awaited: number | undefined;

  constructor(private readonly log: EventLog) {}

  private pending(status: SeatStatus): Move | undefined {
    const game = status.game;
    if (game?.inGame && game.waiting) this.awaited = game.promptCount ?? undefined;
    else if (game?.promptCount !== this.awaited) this.awaited = undefined;
    return pendingMove(status, this.awaited);
  }

  /** The ask to report for this status, or undefined when there is none or it is the one already reported. */
  private take(status: SeatStatus): Move | undefined {
    // A game in progress means the reported result belongs to an earlier game. The next result is then
    // new, even when it ends on the same turn with the same winner.
    if (status.game?.inGame && !status.game.gameOver && !status.game.finished) this.reported = undefined;
    const pending = this.pending(status);
    const move = pending?.data.kind === "game_over" && pending.key === this.reported ? undefined : pending;
    const changed = move !== undefined && move.key !== this.last;
    this.last = move?.key;
    if (changed && move.data.kind === "game_over") this.reported = move.key;
    if (!changed) {
      if (move === undefined) this.lastEvent = undefined;
      return undefined;
    }
    return move;
  }

  observe(status: SeatStatus): EventOccurrence | undefined {
    const move = this.take(status);
    return move && (this.lastEvent = this.log.emit(YOUR_MOVE, move.data));
  }

  /** Like `observe`, and the event also carries what `more` returns for it. An ask is reported with or without it. */
  async observeWith(status: SeatStatus, more: (data: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>): Promise<EventOccurrence | undefined> {
    const move = this.take(status);
    if (!move) return undefined;
    // Until the event exists, the earlier one no longer reports what is pending.
    this.lastEvent = undefined;
    const extra = await more(move.data).catch(() => undefined);
    return (this.lastEvent = this.log.emit(YOUR_MOVE, { ...move.data, ...extra }));
  }

  /** The event that reported the ask pending at the last status, or undefined when there is none. A game result is not an ask here. */
  current(): EventOccurrence | undefined {
    return this.lastEvent?.data.kind === "game_over" ? undefined : this.lastEvent;
  }
}

/**
 * The names our own chat lines can carry: the name we connected with and our lobby slot's name. The host adds
 * " (Host)" to the sender in slot 0 (`FServerManager`), which is a remote seat when the host has none of its own.
 */
function ownNames(status: SeatStatus): Set<string> {
  const names = new Set<string>();
  if (status.connection?.name) names.add(status.connection.name);
  const mySlot = status.lobby?.mySlot ?? -1;
  const slot = status.lobby?.slots?.find((s, i) => (s.index ?? i) === mySlot);
  if (slot?.name) names.add(slot.name);
  if (mySlot === 0) for (const n of [...names]) names.add(`${n} (Host)`);
  return names;
}

/** Emits `forge.chat` for each new chat line from another player. Lines from the server and from our own seat are skipped. */
export class ChatTracker {
  /** The bridge's count of chat lines at the last status. */
  private count: number | undefined;

  constructor(private readonly log: EventLog) {}

  observe(status: SeatStatus): EventOccurrence[] {
    // `chat` is the last 20 lines and `chatCount` counts them all.
    const seen = this.count;
    this.count = status.chatCount ?? 0;
    const added = seen !== undefined && this.count > seen ? (status.chat ?? []).slice(seen - this.count) : [];
    const me = ownNames(status);
    const emitted: EventOccurrence[] = [];
    for (const line of added) {
      if (typeof line === "string") {
        // Bridge 0.1.4 and earlier: `from: text`, so the sender is told from the host's lines by the seat names.
        const others = new Set((status.lobby?.slots ?? []).map((s) => s.name).filter((n) => n && !me.has(n)));
        const at = line.indexOf(": ");
        const from = at > 0 ? line.slice(0, at) : "";
        if (others.has(from)) emitted.push(this.log.emit(CHAT, { from, text: line.slice(at + 2), revision: status.revision }));
      } else if (line.from && !me.has(line.from)) {
        emitted.push(this.log.emit(CHAT, { from: line.from, text: line.text ?? "", revision: status.revision }));
      }
    }
    return emitted;
  }
}

const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false };

export const EVENT_TYPES = [
  {
    name: YOUR_MOVE,
    description:
      "Fires when the Forge seat is asked to act: a seat in the lobby that is not ready yet, a draft pick, a drafted or sealed pool to build a deck from, a priority prompt, a choice dialog, or the end of a game. " +
      "For a priority prompt or a choice in a game the payload is what forge_game_act returns for that prompt, with the board: act on it, and pass its `promptCount` as `at`. " +
      "For a draft pick the payload is what forge_draft_pack returns: the pack, rules text for card names not sent before, the pick clock and counts of your picks. Pick from it with forge_draft_pick, and pass its `at`. " +
      "For a pool the payload has `pool`, what forge_draft_pool returns: build the deck from it with forge_draft_deck. " +
      "For the other kinds the payload is a summary. Read forge_status before acting.",
    inputSchema: NO_ARGUMENTS,
    payloadSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lobby", "draft_pick", "deck", "priority", "decision", "game_over"] },
        prompt: { type: "string" },
        decisionKind: { type: "string" },
        revision: { type: "integer", description: "Bridge revision the ask was seen at" },
        secondsLeft: { type: "integer", description: "Left on the pick clock when a draft pick was asked for, if the host set one" },
        at: { type: "string", description: "For kind draft_pick: names the pack. Pass it as `at` to forge_draft_pick." },
        packNumber: { type: "integer" },
        pickNumber: { type: "integer" },
        pack: { type: "array", description: "For kind draft_pick: the cards to pick from" },
        queued: { type: "integer", description: "Packs waiting for the seat behind this one" },
        drafted: { type: "object", description: "Counts of the seat's picks so far" },
        autoPicks: { type: "array", description: "Picks the host made for the seat when the clock ran out" },
        pool: { type: "object", description: "For kind deck: the pool, one entry per card name, with counts" },
        turn: { type: "integer" },
        phase: { type: "string" },
        promptCount: { type: "integer", description: "For kinds priority and decision: the prompt this event reports. Pass it as `at` to forge_game_act." },
        matchOver: { type: "boolean", description: "For kind game_over: whether that game decided the match. False means another game follows." },
        score: { type: "object", description: "For kind game_over: games won in the match, by player name" },
        sideboarding: { type: "boolean", description: "For kind game_over: the seat may change its deck for the next game, with `in` and `out` on its `continue`" },
        sideboard: { type: "array", description: "With sideboarding: the cards in the seat's sideboard, by name with counts" },
        activePlayer: { type: "string" },
        buttons: { type: "object", description: "The labels of the enabled buttons" },
        life: { type: "object" },
        hand: { type: "array" },
        stack: { type: "array" },
        mana: { type: "object" },
        combat: { type: "array" },
        selection: { type: "object" },
        actionable: { type: "array" },
        pendingDecision: { type: "object" },
        board: { type: "array", description: "Each player's battlefield and zone sizes" },
        cardText: { type: "object", description: "Rules text for card names not sent before" },
        since: { type: "object", description: "What has happened since the seat's last game tool result" },
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

/**
 * Waits on the bridge until the seat is asked something, another player chats, or `timeout` seconds pass, and
 * returns the status then. A change that asks nothing of the seat, such as the opponent's priority, does not return.
 */
export async function waitForAsk(
  wait: (since: number, timeout: number) => Promise<SeatStatus>,
  since: number,
  timeout: number,
): Promise<SeatStatus> {
  const deadline = Date.now() + timeout * 1000;
  let awaited: number | undefined;
  const asked = (status: SeatStatus): boolean => {
    const game = status.game;
    if (game?.inGame && game.waiting) awaited = game.promptCount ?? undefined;
    else if (game?.promptCount !== awaited) awaited = undefined;
    return pendingMove(status, awaited) !== undefined;
  };
  // The status now, which answers at once, gives the chat count to compare with.
  let status = await wait(-1, 1);
  if (since < 0) return status;
  const chatCount = status.chatCount ?? 0;
  const chatted = (status: SeatStatus): boolean => {
    const count = status.chatCount ?? 0;
    const added = count > chatCount ? (status.chat ?? []).slice(chatCount - count) : [];
    const me = ownNames(status);
    return added.some((line) => typeof line === "string" || (line.from != null && !me.has(line.from)));
  };
  for (;;) {
    const revision = status.revision ?? since;
    if (revision > since && (asked(status) || chatted(status))) return status;
    since = Math.max(since, revision);
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return status;
    status = await wait(since, left);
    // The bridge answers with an unchanged revision when its own timeout ran out.
    if ((status.revision ?? since) <= since) return status;
  }
}
