import { sortColors, type CardIndex, type Editions } from "./cards.js";

export interface Entry {
  count: number;
  name: string;
  /** Set code as the source gave it. */
  set?: string;
  /** Everything after the name in a `.dck` line (`|SET|art`), kept as written. */
  suffix?: string;
}

export type Section =
  | "Commander"
  | "Main"
  | "Sideboard"
  | "Avatar"
  | "Planes"
  | "Schemes"
  | "Conspiracy"
  | "Dungeon"
  | "Attractions"
  | "Contraptions"
  | "Stickers";

/** Forge's deck sections, in the order a deck file lists them. */
export const SECTIONS: Section[] = [
  "Commander",
  "Main",
  "Sideboard",
  "Avatar",
  "Planes",
  "Schemes",
  "Conspiracy",
  "Dungeon",
  "Attractions",
  "Contraptions",
  "Stickers",
];

export interface Decklist {
  name?: string;
  /** Format as the source names it: modern, commander, cube and so on. */
  format?: string;
  /** `[metadata]` entries other than the name, kept in order. */
  meta: [string, string][];
  /** Sections of a `.dck` file that are not card lists (`[shop]`, `[duel]`), kept as written. */
  extra: string[];
  sections: Partial<Record<Section, Entry[]>>;
}

export const emptyDecklist = (): Decklist => ({ meta: [], extra: [], sections: {} });

export function addEntry(deck: Decklist, section: Section, entry: Entry): void {
  if (!(entry.count > 0) || !entry.name) return;
  (deck.sections[section] ??= []).push(entry);
}

export const countCards = (entries: Entry[] | undefined): number => (entries ?? []).reduce((n, e) => n + e.count, 0);

const sectionByName = new Map(SECTIONS.map((s) => [s.toLowerCase(), s]));

/** Parses Forge `.dck` text. */
export function parseDck(text: string): Decklist {
  const deck = emptyDecklist();
  let section: Section | "metadata" | "extra" | undefined;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const key = header[1].trim().toLowerCase();
      section = key === "metadata" ? "metadata" : (sectionByName.get(key) ?? "extra");
      if (section === "extra") deck.extra.push(line);
      continue;
    }
    if (!line) continue;
    if (section === "extra") {
      deck.extra.push(line);
    } else if (section === "metadata") {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key.toLowerCase() === "name") deck.name = value;
      else deck.meta.push([key, value]);
    } else if (!line.startsWith(";") && !line.startsWith("#")) {
      // Forge's own pattern: an optional count, then the card request. A file with no section headers is all Main.
      const m = /^(?:(\d+)\s+)?(.+)$/.exec(line)!;
      const bar = m[2].indexOf("|");
      const name = (bar < 0 ? m[2] : m[2].slice(0, bar)).trim();
      addEntry(deck, section ?? "Main", {
        count: m[1] ? Number(m[1]) : 1,
        name,
        suffix: bar < 0 ? undefined : m[2].slice(bar),
      });
    }
  }
  return deck;
}

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'" };
export const decodeEntities = (s: string): string => s.replace(/&(#?\w+);/g, (all, e: string) => xmlEntities[e] ?? all);

/** Parses a Magic Online `.dek` file. */
export function parseDek(xml: string): Decklist {
  const deck = emptyDecklist();
  for (const tag of xml.match(/<Cards\b[^>]*>/g) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = decodeEntities(m[2]);
    addEntry(deck, attrs.Sideboard === "true" ? "Sideboard" : "Main", { count: Number(attrs.Quantity), name: attrs.Name });
  }
  return deck;
}

const HEADERS: [RegExp, Section | "skip"][] = [
  [/^(deck|main|main ?board|main ?deck)$/, "Main"],
  [/^(sideboard|side|sb|companion)$/, "Sideboard"],
  [/^(commanders?|command zone|cmdr|signature spells?)$/, "Commander"],
  [/^(maybe ?board|considering|tokens?|wishlist)$/, "skip"],
  [/^planes$/, "Planes"],
  [/^schemes$/, "Schemes"],
  [/^attractions$/, "Attractions"],
  [/^stickers$/, "Stickers"],
];

/** `4 Name`, `4x Name`, `4 Name (SET) 123`, `4 [SET] Name`, `SB: 2 Name`, `1 Name *CMDR*`, or a bare name. */
function parseCardLine(line: string): (Entry & { sideboard: boolean; commander: boolean; counted: boolean }) | undefined {
  let rest = line;
  const sideboard = /^SB:\s*/i.test(rest);
  rest = rest.replace(/^SB:\s*/i, "");
  const counted = /^(\d+)\s*x?\s+(.+)$/i.exec(rest);
  const count = counted ? Number(counted[1]) : 1;
  rest = counted ? counted[2] : rest;
  const commander = /\*CMDR\*|#\s*!Commander/i.test(rest);
  rest = rest.replace(/\s+#.*$/, "").replace(/\*[A-Z]+\*/g, "").trim();
  let set: string | undefined;
  const lead = /^\[([A-Za-z0-9]*)\]\s*(.+)$/.exec(rest);
  if (lead) {
    set = lead[1] || undefined;
    rest = lead[2];
  }
  const trail = /^(.+?)\s+[([]([A-Za-z0-9]{2,6})[)\]](?:\s+\S+)?(?:\s+\*F\*)?$/.exec(rest);
  if (trail) {
    set = trail[2];
    rest = trail[1];
  }
  const name = rest.trim();
  if (!name || !/[A-Za-z]/.test(name)) return undefined;
  return { count, name, set, sideboard, commander, counted: counted !== null };
}

/**
 * Parses a plain decklist: the text exports of Arena, Magic Online and the deck sites, with or
 * without section headers and set codes.
 */
export function parseText(text: string): Decklist {
  const deck = emptyDecklist();
  // Groups of card lines. A header starts a named group; a blank line starts an unnamed one.
  const groups: { section?: Section | "skip"; entries: ReturnType<typeof parseCardLine>[] }[] = [{ entries: [] }];
  let about = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      about = false;
      if (groups[groups.length - 1].entries.length > 0) groups.push({ entries: [] });
      continue;
    }
    const word = line.replace(/^(\/\/|#)\s*/, "").replace(/[:\s]*(\(\d+\))?$/, "").toLowerCase();
    if (word === "about") {
      about = true;
      continue;
    }
    if (about) {
      const named = /^Name\s+(.+)$/i.exec(line);
      if (named) deck.name = named[1].trim();
      continue;
    }
    const header = HEADERS.find(([pattern]) => pattern.test(word));
    if (header) {
      if (groups[groups.length - 1].entries.length === 0) groups.pop();
      groups.push({ section: header[1], entries: [] });
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) continue;
    groups[groups.length - 1].entries.push(parseCardLine(line));
  }
  // A list either counts every card or none (a cube). In a counted list, uncounted lines are type headings.
  if (groups.some((g) => g.entries.some((e) => e?.counted))) {
    for (const g of groups) g.entries = g.entries.filter((e) => e?.counted);
  }
  const filled = groups.filter((g) => g.entries.some(Boolean));
  const headed = filled.some((g) => g.section);
  const size = (g: (typeof filled)[number]): number => g.entries.reduce((n, e) => n + (e?.count ?? 0), 0);
  let main = 0;
  filled.forEach((group, i) => {
    let section = group.section;
    if (!section) {
      const last = i > 0 && i === filled.length - 1;
      if (last && size(group) <= 2 && (main + size(group) === 100 || main + size(group) === 60)) {
        // One or two cards set apart at the end of a 100 or 60 card list: the commander.
        section = "Commander";
      } else if (headed) {
        // An unnamed group after a named one continues it.
        section = filled.slice(0, i).reverse().find((g) => g.section)?.section ?? "Main";
      } else {
        // Two unnamed groups are main deck and sideboard. More than two are one deck listed by card type.
        section = filled.length === 2 && i === 1 && size(group) <= 15 ? "Sideboard" : "Main";
      }
    }
    if (section === "Main") main += size(group);
    if (section === "skip") return;
    for (const e of group.entries) {
      if (!e) continue;
      const { sideboard, commander, counted: _counted, ...entry } = e;
      addEntry(deck, commander ? "Commander" : sideboard ? "Sideboard" : section, entry);
    }
  });
  return deck;
}

/** Parses deck text in any supported form: Forge `.dck`, Magic Online `.dek`, or a plain list. */
export function parseAny(text: string): Decklist {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<")) return parseDek(text);
  if (/^\s*\[(metadata|main|commander|sideboard|shop|duel)\]\s*$/im.test(text)) return parseDck(text);
  return parseText(text);
}

/**
 * Rewrites every card name to the one Forge uses and merges repeated lines. Names Forge does not
 * implement are returned in `unknown` and left out of the deck.
 */
export function resolveNames(deck: Decklist, cards: CardIndex, editions?: Editions): { deck: Decklist; unknown: string[] } {
  const unknown = new Set<string>();
  const sections: Decklist["sections"] = {};
  for (const section of SECTIONS) {
    const merged = new Map<string, Entry>();
    for (const entry of deck.sections[section] ?? []) {
      const card = cards.find(entry.name);
      if (!card) {
        unknown.add(entry.name);
        continue;
      }
      const set = entry.set ? editions?.canonical(entry.set) : undefined;
      const suffix = entry.suffix ?? (set ? `|${set}` : undefined);
      const key = `${card.name}${suffix ?? ""}`;
      const seen = merged.get(key);
      if (seen) seen.count += entry.count;
      else merged.set(key, { count: entry.count, name: card.name, suffix });
    }
    if (merged.size > 0) sections[section] = [...merged.values()];
  }
  return { deck: { ...deck, sections }, unknown: [...unknown] };
}

/** Colours of the nonland cards in the main deck and command zone, in WUBRG order. */
export function deckColors(deck: Decklist, cards: CardIndex): string {
  const found: string[] = [];
  for (const section of ["Commander", "Main"] as const) {
    for (const entry of deck.sections[section] ?? []) {
      const card = cards.find(entry.name);
      if (card && !card.land) found.push(...card.colors);
    }
  }
  return sortColors(found);
}

/** Writes Forge `.dck` text. */
export function toDck(deck: Decklist): string {
  const lines = [...deck.extra, "[metadata]", `Name=${deck.name ?? ""}`];
  for (const [key, value] of deck.meta) lines.push(`${key}=${value}`);
  for (const section of SECTIONS) {
    const entries = deck.sections[section];
    if (!entries?.length) continue;
    lines.push(`[${section}]`);
    for (const e of entries) lines.push(`${e.count} ${e.name}${e.suffix ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
