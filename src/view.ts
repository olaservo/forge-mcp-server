import type { Bridge } from "./bridge.js";
import { compactGame, DEFAULTS } from "./game-state.js";

type Json = Record<string, unknown>;
type Card = Record<string, unknown>;

/** Game log lines that say nothing a seat acts on. */
const LOG_NOISE = /^(Phase|Mana|Player Control):/;
/** The lines that give a game's result and the match score. */
const EARLIER_RESULT = /^(Game Outcome|Match Result):/;
/** The most log lines one view carries. Older ones are counted in `earlier`. */
const LOG_LINES = 15;
/** How many event views are kept for an action to name with `at`. */
const PEEKS = 8;

/**
 * Card and stack text as Forge sends it, made plain: Forge joins abilities with blank Windows lines and
 * wraps text that does not apply now, such as an ability whose condition is not met, in a gray span.
 */
export function plainText(text: string): string {
  return text
    .replace(/<span style="color:gray;">([\s\S]*?)<\/span>/g, (_m, inner: string) => (inner.trim() ? `[inactive] ${inner.trim()}` : ""))
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** What the seat has been told so far in this game. */
interface Told {
  /** Game log lines and bridge messages already given. */
  log: number;
  messages: number;
  /** Card ids in hand at the last view, or undefined before the first. */
  hand?: Set<number>;
  incorrect: number;
  /** The text first seen for each card name. A card whose text differs from it carries its own. */
  text: Map<string, string>;
  /** The seat's turn on which a view last carried the board. */
  boardTurn: number;
  /** Which game this is, when the bridge says: its count of games opened, or the game's number in its match. */
  game?: number;
}

const fresh = (): Told => ({ log: 0, messages: 0, incorrect: 0, text: new Map(), boardTurn: -1 });

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** A card without its text, its fields at their default, and the zone or controller its list already says. */
function brief(card: Card, zone?: string, controller?: unknown): Card {
  const out: Card = {};
  for (const [key, value] of Object.entries(card)) {
    if (value === null || value === undefined || key === "text" || DEFAULTS[key] === value) continue;
    if (key === "zone" && value === zone) continue;
    if (key === "controller" && value === controller) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Builds what a game tool returns and what `forge.your_move` carries: the ask, what is needed to answer it,
 * and what has happened since the seat was last told. One per bridge, since it remembers what was told.
 */
export class SeatMemory {
  private told = fresh();
  /** Deck cards whose text the seat got when it set the deck. */
  private briefed = new Set<string>();
  /** What the seat would have been told had it read an event's view, by that view's prompt count. */
  private peeks = new Map<number, Told>();

  /** The seat's deck was described to it: the game need not send these cards' text again. */
  brief(names: Iterable<string>): void {
    this.briefed = new Set(names);
  }

  /** The seat acted on the prompt with this count, so it has read the event that reported it. */
  saw(promptCount: number | undefined): void {
    const next = promptCount === undefined ? undefined : this.peeks.get(promptCount);
    if (next) this.told = next;
  }

  /**
   * A new game counts its log and messages from nothing. Forge's client keeps one log through the games of a
   * match and through the matches of a lobby, so those counts do not drop there. Bridge 0.1.11 counts the
   * games it opens: another game starts fresh too, but for its place in the log.
   */
  private start(game: Json): Told {
    const restarted = Number(game.logCount ?? 0) < this.told.log || Number(game.messageCount ?? 0) < this.told.messages;
    const left = game.inGame === false && game.gameOver !== true && game.finished !== true;
    // Without the count, the game's number in its match tells the games of one match apart.
    const number = game.gamesOpened ?? (game.match as Json | null | undefined)?.game;
    if (restarted || left) {
      this.told = fresh();
      this.peeks.clear();
    } else if (typeof number === "number" && this.told.game !== undefined && number !== this.told.game) {
      // The bridge counts refused actions through the games too.
      this.told = { ...fresh(), log: this.told.log, incorrect: this.told.incorrect };
      this.peeks.clear();
    }
    if (typeof number === "number") this.told.game = number;
    return { ...this.told, hand: this.told.hand && new Set(this.told.hand), text: new Map(this.told.text) };
  }

  /** Moves card text into `into` for names not sent before, and leaves it on a card where it differs from its name's. */
  private texts(cards: Card[], told: Told, into: Record<string, string>, all = false): void {
    for (const card of cards) {
      if (typeof card.text !== "string" || typeof card.name !== "string" || card.text === "") {
        delete card.text;
        continue;
      }
      const text = plainText(card.text);
      const known = told.text.get(card.name);
      if (known === undefined) told.text.set(card.name, text);
      if (known === undefined || known === text) {
        delete card.text;
        if (all || (known === undefined && !this.briefed.has(card.name))) into[card.name] = text;
      } else {
        card.text = text;
      }
    }
  }

  /** What has happened since the seat was last told. */
  private async since(bridge: Bridge, game: Json, me: Json | undefined, told: Told): Promise<Json | undefined> {
    const since: Json = {};
    const logCount = Number(game.logCount ?? 0);
    if (logCount > told.log) {
      const { log } = await bridge.get<{ log?: string[] }>("/game/log", { since: told.log });
      // Lines before `logStart` are from an earlier game of the match (bridge 0.1.11). Of those the seat has not been told, only the result is.
      const logStart = Number(game.logStart ?? 0);
      const from = told.log;
      const lines = (log ?? [])
        .filter((l, i) => from + i >= logStart || EARLIER_RESULT.test(l))
        .map((l) => plainText(l))
        .filter((l) => l && !LOG_NOISE.test(l));
      if (lines.length > LOG_LINES) since.earlier = lines.length - LOG_LINES;
      if (lines.length) since.log = lines.slice(-LOG_LINES);
      told.log = logCount;
    }
    const messageCount = Number(game.messageCount ?? 0);
    const messages = Array.isArray(game.messages) ? (game.messages as string[]) : [];
    if (messageCount > told.messages) {
      since.messages = messages.slice(-Math.min(messageCount - told.messages, messages.length)).map(plainText);
      told.messages = messageCount;
    }
    if (me && Array.isArray(me.hand)) {
      const hand = list(me.hand);
      const before = told.hand;
      if (before) {
        const added = hand.filter((c) => !before.has(Number(c.id))).map((c) => String(c.name));
        if (added.length) since.newInHand = added;
      }
      told.hand = new Set(hand.map((c) => Number(c.id)));
    }
    return Object.keys(since).length ? since : undefined;
  }

  /**
   * The view of a full `GET /game` answer. With `commit` the seat is taken to have read it, as it has a tool
   * result. Without, as for an event that may never reach the model, it is kept until an action names its
   * prompt count. `board` adds both battlefields: asked for where a seat plans, when an event starts a turn.
   * A tool result adds it by itself the first time it returns the seat's main phase in a turn.
   */
  async view(bridge: Bridge, game: Json, opts: { commit: boolean; board?: boolean; stale?: boolean }): Promise<Json> {
    const told = this.start(game);
    const players = list(game.players);
    const me = players.find((p) => p.isMe === true);
    const over = game.gameOver === true || game.finished === true;
    const view: Json = { prompt: game.prompt, promptCount: game.promptCount };
    if (opts.stale) view.stale = true;
    if (game.inGame === false && !over) view.inGame = false;
    if (over) Object.assign(view, { gameOver: true, winner: game.winner }, game.match != null && { match: game.match });
    for (const key of ["turn", "phase", "activePlayer"]) if (game[key] !== null && game[key] !== undefined) view[key] = game[key];
    if (game.waiting === true) view.waiting = true;
    const b = (game.buttons ?? {}) as Json;
    const buttons: Json = {};
    if (b.okEnabled) buttons.ok = b.ok;
    if (b.cancelEnabled) buttons.cancel = b.cancel;
    if (Object.keys(buttons).length) view.buttons = buttons;
    if (Number(game.incorrectActions ?? 0) > told.incorrect) view.refused = true;
    told.incorrect = Number(game.incorrectActions ?? 0);
    if (players.length) view.life = Object.fromEntries(players.map((p) => [String(p.name), p.life]));

    const text: Record<string, string> = {};
    const shown: Card[] = [];
    const places = new Map<Card, [string | undefined, unknown]>();
    const show = (cards: Json[], zone?: string, controller?: unknown) => {
      const copies = cards.map((c) => ({ ...c }));
      for (const copy of copies) places.set(copy, [zone, controller]);
      shown.push(...copies);
      return copies;
    };
    const asked = game.waiting !== true && !over;
    const priority = asked && game.priorityPrompt === true;
    const stack = list(game.stack);
    // Before the first turn the seat is asked whether it keeps its hand, in a prompt that offers no priority.
    const opening = asked && (game.phase === null || game.phase === undefined);
    if ((priority || opening) && me && list(me.hand).length) view.hand = show(list(me.hand), "Hand", me.name);
    if (stack.length) {
      view.stack = stack.map((s) => ({
        by: s.by,
        source: s.source,
        text: plainText(String(s.text ?? "")),
        ...(list(s.targets).length ? { targets: s.targets } : {}),
      }));
    }
    const mana = (me?.mana ?? {}) as Json;
    if (Object.keys(mana).length) view.mana = mana;
    if (list(game.combat).length) view.combat = game.combat;
    const selection = game.selection as Json | null | undefined;
    if (asked && selection) view.selection = { ...selection, cards: show(list(selection.cards)) };
    if (asked && list(game.actionable).length) view.actionable = game.actionable;
    if (game.pendingDecision) view.pendingDecision = game.pendingDecision;

    const myMain = priority && me !== undefined && game.activePlayer === me.name && String(game.phase).startsWith("MAIN") && stack.length === 0;
    const turn = Number(game.turn ?? -1);
    if (asked && players.length && (opts.board || (myMain && told.boardTurn !== turn))) {
      view.board = players.map((p) => ({
        name: p.name,
        handSize: p.handSize,
        librarySize: p.librarySize,
        graveyardSize: p.graveyardSize,
        battlefield: show(list(p.battlefield), "Battlefield", p.name),
      }));
      if (myMain) told.boardTurn = turn;
    }
    this.texts(shown, told, text);
    for (const card of shown) {
      const small = brief(card, ...places.get(card)!);
      if (card.text !== undefined) small.text = card.text;
      for (const key of Object.keys(card)) delete card[key];
      Object.assign(card, small);
    }
    if (Object.keys(text).length) view.cardText = text;

    const since = await this.since(bridge, game, me, told);
    if (since) view.since = since;

    if (opts.commit) {
      this.told = told;
    } else if (typeof game.promptCount === "number") {
      this.peeks.set(game.promptCount, told);
      for (const count of [...this.peeks.keys()].slice(0, -PEEKS)) this.peeks.delete(count);
    }
    return view;
  }

  /** `forge_game_state`: the compact game, with rules text only for card names not sent before unless `allText`, and what is new. */
  async state(bridge: Bridge, game: Json, allText: boolean): Promise<Json> {
    const told = this.start(game);
    const compact = compactGame(game);
    const players = list(compact.players);
    const cards = players.flatMap((p) => [...list(p.battlefield), ...list(p.graveyard), ...list(p.hand)]);
    const selection = compact.selection as Json | undefined;
    cards.push(...list(selection?.cards));
    // compactGame has moved each name's text into cardText: put it back so one rule decides what is sent.
    const moved = (compact.cardText ?? {}) as Record<string, string>;
    for (const card of cards) if (card.text === undefined && typeof card.name === "string" && moved[card.name] !== undefined) card.text = moved[card.name];
    const text: Record<string, string> = {};
    this.texts(cards, told, text, allText);
    compact.cardText = text;
    for (const item of list(compact.stack)) item.text = plainText(String(item.text ?? ""));
    const since = await this.since(bridge, game, list(game.players).find((p) => p.isMe === true), told);
    if (since) compact.since = since;
    delete compact.messages;
    told.incorrect = Number(game.incorrectActions ?? 0);
    this.told = told;
    return compact;
  }
}

const memories = new WeakMap<Bridge, SeatMemory>();

/** One memory per bridge, shared by every server instance of the process. */
export function memoryFor(bridge: Bridge): SeatMemory {
  let memory = memories.get(bridge);
  if (!memory) memories.set(bridge, (memory = new SeatMemory()));
  return memory;
}
