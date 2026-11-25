import type { Bridge } from "./bridge.js";
import { plainText } from "./view.js";

type Json = Record<string, unknown>;

/** How long forge_draft_pick holds its answer for the next pack or the pool. */
export const PICK_HOLD_MS = 2000;
/** How many event views are kept for a pick or a deck to name. */
const PEEKS = 4;
const COLOR_ORDER = ["W", "U", "B", "R", "G"];

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const key = (name: unknown): string => String(name ?? "").trim().toLowerCase();

/** The mana value of a cost as the bridge writes it, such as `{2}{W}{W}`. A land's "no cost" is 0. */
export function manaValue(cost: unknown): number {
  let total = 0;
  for (const [, symbol] of String(cost ?? "").matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+/.test(symbol)) total += Number.parseInt(symbol, 10);
    else if (!/^[XYZ]$/.test(symbol)) total += 1;
  }
  return total;
}

const isLand = (card: Json): boolean => /\bLand\b/.test(String(card.type ?? ""));
const colorsOf = (card: Json): string[] => String(card.colors ?? "").match(/[WUBRG]/g) ?? [];

/** Counts of a list of cards: by colour, creatures and other spells, lands, and the mana values of the spells. */
export function tally(cards: Json[], unknown = 0): Json {
  const colors: Record<string, number> = {};
  const curve: Record<string, number> = {};
  let creatures = 0;
  let other = 0;
  let lands = 0;
  for (const card of cards) {
    if (isLand(card)) {
      lands++;
      continue;
    }
    if (/\bCreature\b/.test(String(card.type ?? ""))) creatures++;
    else other++;
    const mine = colorsOf(card);
    for (const color of mine.length ? mine : ["colorless"]) colors[color] = (colors[color] ?? 0) + 1;
    const value = manaValue(card.manaCost);
    const slot = value >= 6 ? "6+" : String(value);
    curve[slot] = (curve[slot] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(curve).sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10)));
  return { count: cards.length + unknown, colors, creatures, other, ...(lands > 0 ? { lands } : {}), ...(unknown > 0 ? { unknown } : {}), curve: sorted };
}

/** What names the pack waiting for a pick, as `pack:pick`, or undefined when none is. A bridge before 0.1.11 does not send it. */
export function packAt(draft: Json): string | undefined {
  if (draft.pickPending !== true) return undefined;
  return typeof draft.at === "string" ? draft.at : `${String(draft.packNumber)}:${String(draft.pickNumber)}`;
}

/** A pack or pool card without its text, its printing, and the fields that say nothing. */
function shown(card: Json): Json {
  const out: Json = { name: card.name };
  if (card.manaCost && card.manaCost !== "no cost") out.manaCost = card.manaCost;
  if (card.type) out.type = card.type;
  if (card.power != null && card.toughness != null) out.pt = `${String(card.power)}/${String(card.toughness)}`;
  if (card.rarity && card.rarity !== "Common" && card.rarity !== "BasicLand") out.rarity = card.rarity;
  return out;
}

/** Forge's card scripts write a line break inside rules text as the two characters `\n`. */
const oracle = (card: Json): string => plainText(String(card.oracle ?? "").replaceAll("\\n", "\n"));

/** Where a card sorts in a pool: by colour, then many colours, colourless, lands. */
function group(card: Json): number {
  if (isLand(card)) return 8;
  const mine = colorsOf(card);
  if (mine.length === 0) return 7;
  return mine.length > 1 ? 6 : COLOR_ORDER.indexOf(mine[0]);
}

/**
 * Builds what the draft tools return and what `forge.your_move` carries for a pick or a pool: the cards without
 * their printing, rules text once per card name, and counts of what the seat has drafted. One per bridge.
 */
export class DraftMemory {
  /** Card names whose rules text the seat has been sent in this event. */
  private told = new Set<string>();
  /** What the seat would have been told had it read an event's view, by the ask the view was for. */
  private peeks = new Map<string, Set<string>>();
  /** Every card seen in a pack or the pool, by name, for counting the picks. */
  private known = new Map<string, Json>();
  /** Deck cards whose text a forge_draft_deck answer carried. */
  private deckTold = new Set<string>();
  private pickCount = 0;
  private poolEvent: string | undefined;
  /** The packs the seat may have been shown last: one after a tool result, more once an event has reported a later pack. */
  private shown: string[] = [];
  /** Whether the bridge checks a pick's `at` with the pick, known once a draft answer of its has been read. Bridge 0.1.11. */
  bridgeChecks: boolean | undefined;

  /** The `at` of the pack the seat was last told of, when there is no doubt which pack that was. */
  lastTold(): string | undefined {
    return this.shown.length === 1 ? this.shown[0] : undefined;
  }

  /** A pick was sent, and what the seat is shown next could not be read. */
  picked(): void {
    this.shown = [];
  }

  private reset(): void {
    this.shown = [];
    this.told.clear();
    this.peeks.clear();
    this.known.clear();
    this.deckTold.clear();
    this.poolEvent = undefined;
  }

  /** Rules text for the names not sent before, or for every name with `all`. Adds them to `told`. */
  private texts(cards: Json[], told: Set<string>, all = false): Record<string, string> {
    const text: Record<string, string> = {};
    for (const card of cards) {
      const name = String(card.name ?? "");
      const words = oracle(card);
      if (!name || !words) continue;
      if (all || !told.has(name)) text[name] = words;
      told.add(name);
    }
    return text;
  }

  private keep(told: Set<string>, ask: string, commit: boolean): void {
    if (commit) {
      this.told = told;
      return;
    }
    this.peeks.set(ask, told);
    for (const old of [...this.peeks.keys()].slice(0, -PEEKS)) this.peeks.delete(old);
  }

  /** The seat answered this ask, so it has read the event that reported it. */
  saw(ask: string): void {
    for (const name of this.peeks.get(ask) ?? []) this.told.add(name);
  }

  /**
   * The view of a `GET /draft/pack` answer. With `commit` the seat is taken to have read it, as it has a tool
   * result. Without, as for an event that may never reach the model, it is kept until a pick names that pack.
   */
  pack(draft: Json, opts: { commit: boolean; allText?: boolean }): Json {
    const picks = Array.isArray(draft.picks) ? (draft.picks as string[]) : [];
    // The bridge clears the pick list when a new event starts.
    if (picks.length < this.pickCount) this.reset();
    this.pickCount = picks.length;
    const cards = list(draft.pack);
    for (const card of cards) this.known.set(key(card.name), card);
    const view: Json = {};
    this.bridgeChecks = "at" in draft;
    if (draft.pickPending !== true && opts.commit) this.shown = [];
    if (draft.pickPending === true) {
      const at = packAt(draft)!;
      if (opts.commit) this.shown = [at];
      else if (!this.shown.includes(at)) this.shown.push(at);
      view.at = at;
      view.packNumber = draft.packNumber;
      view.pickNumber = draft.pickNumber;
      if (typeof draft.secondsLeft === "number") view.secondsLeft = draft.secondsLeft;
      view.pack = cards.map(shown);
      const told = new Set(this.told);
      const text = this.texts(cards, told, opts.allText);
      if (Object.keys(text).length) view.cardText = text;
      this.keep(told, `pack:${String(draft.packNumber)}:${String(draft.pickNumber)}`, opts.commit);
    } else if (draft.poolReceived === true) {
      view.poolReceived = true;
    } else {
      view.waiting = true;
    }
    const mine = picks.map((name) => this.known.get(key(name)));
    const seen = mine.filter((card): card is Json => card !== undefined);
    if (picks.length) view.drafted = tally(seen, mine.length - seen.length);
    if (Array.isArray(draft.autoPicks) && draft.autoPicks.length) view.autoPicks = draft.autoPicks;
    return view;
  }

  /** The view of a `GET /draft/pool` answer: one entry per card name, sorted by colour and cost, with counts. */
  pool(pool: Json, opts: { commit: boolean; allText?: boolean }): Json {
    if (pool.poolReceived !== true) return { poolReceived: false };
    const event = String(pool.eventId ?? "");
    // A second pool with no pack in between is a sealed event after an earlier event.
    if (this.poolEvent !== undefined && this.poolEvent !== event) this.reset();
    this.poolEvent = event;
    const cards = list(pool.cards);
    const byName = new Map<string, { card: Json; count: number }>();
    for (const card of cards) {
      this.known.set(key(card.name), card);
      const entry = byName.get(String(card.name));
      if (entry) entry.count++;
      else byName.set(String(card.name), { card, count: 1 });
    }
    const sorted = [...byName.values()].sort(
      (a, b) => group(a.card) - group(b.card) || manaValue(a.card.manaCost) - manaValue(b.card.manaCost) || String(a.card.name).localeCompare(String(b.card.name)),
    );
    const told = new Set(this.told);
    const text = this.texts(cards, told, opts.allText);
    this.keep(told, `pool:${event}`, opts.commit);
    return {
      poolReceived: true,
      eventId: pool.eventId,
      name: pool.name,
      landSet: pool.landSet,
      size: pool.size,
      counts: tally(cards),
      cards: sorted.map(({ card, count }) => ({ count, ...shown(card) })),
      ...(Object.keys(text).length > 0 ? { cardText: text } : {}),
    };
  }

  /**
   * The deck the seat built, from the pool it came from: each main-deck card with its count and, the first time a
   * deck answer names it, its rules text. `briefed` has the names the game need not send text for again.
   */
  deck(pool: Json, main: string[]): { cards: Json[]; counts: Json; briefed: string[] } {
    this.saw(`pool:${String(pool.eventId ?? "")}`);
    const byName = new Map(list(pool.cards).map((card) => [key(card.name), card]));
    const entries = new Map<string, { card: Json; count: number }>();
    for (const name of main) {
      const card = byName.get(key(name));
      if (!card) continue;
      const entry = entries.get(key(name));
      if (entry) entry.count++;
      else entries.set(key(name), { card, count: 1 });
    }
    const chosen = [...entries.values()];
    const cards = chosen.map(({ card, count }) => {
      const name = String(card.name);
      const text = oracle(card);
      const out: Json = { count, ...shown(card) };
      if (text && !this.deckTold.has(name)) out.text = text;
      this.deckTold.add(name);
      return out;
    });
    return {
      cards,
      counts: tally(chosen.flatMap(({ card, count }) => Array.from({ length: count }, () => card))),
      briefed: chosen.map(({ card }) => String(card.name)),
    };
  }
}

const memories = new WeakMap<Bridge, DraftMemory>();

/** One memory per bridge, shared by every server instance of the process. */
export function draftFor(bridge: Bridge): DraftMemory {
  let memory = memories.get(bridge);
  if (!memory) memories.set(bridge, (memory = new DraftMemory()));
  return memory;
}

/**
 * After a pick: the draft as it stands once the next pack or the pool has arrived, or after `holdMs` with neither.
 * A pack that was queued for the seat arrives at once, so most picks are answered with the next pack.
 */
export async function afterPick(bridge: Bridge, holdMs = PICK_HOLD_MS): Promise<Json> {
  const deadline = Date.now() + holdMs;
  let status = await bridge.get<{ revision?: number; draft?: Json }>("/wait", { since: -1, timeout: 1 });
  for (;;) {
    const draft = status.draft ?? {};
    // The pick cleared `pickPending`, so a pending pick is the next pack.
    if (draft.pickPending === true || draft.poolReceived === true) return draft;
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return draft;
    const since = status.revision ?? -1;
    status = await bridge.get<{ revision?: number; draft?: Json }>("/wait", { since, timeout: left });
    // The bridge answers with an unchanged revision when its own timeout ran out.
    if ((status.revision ?? since) <= since) return status.draft ?? {};
  }
}
