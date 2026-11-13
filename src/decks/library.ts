import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadCardIndex, loadEditions, type CardIndex, type Editions } from "./cards.js";
import { countCards, deckColors, parseDck, resolveNames, toDck, type Decklist, type Entry, type Section } from "./decklist.js";

export interface ForgeDirs {
  /** Forge's `res` folder, when `FORGE_HOME` is set. */
  res?: string;
  /** The user's deck folder. */
  decks: string;
  /** The user's custom card scripts. */
  customCards: string;
}

/** Reads a Java properties file's `key=value` lines. */
function properties(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([^#!=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\\\\/g, "\\").trim();
  }
  return out;
}

/**
 * Where Forge keeps decks, by Forge's own rules: `forge.profile.properties` in the install folder,
 * else the platform default. `FORGE_USER_DIR` and `FORGE_DECKS_DIR` override both.
 */
export function forgeDirs(env: NodeJS.ProcessEnv = process.env): ForgeDirs {
  const home = env.FORGE_HOME;
  const profile = home ? properties(join(home, "forge.profile.properties")) : {};
  const fallback = join(homedir(), ".forge");
  const platformDefault =
    process.platform === "win32"
      ? join(env.APPDATA || fallback, env.APPDATA ? "Forge" : "")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Forge")
        : fallback;
  const user = env.FORGE_USER_DIR || profile.userDir || platformDefault;
  return {
    res: home ? join(home, "res") : undefined,
    decks: env.FORGE_DECKS_DIR || profile.decksDir || join(user, "decks"),
    customCards: join(user, "custom", "cards"),
  };
}

export interface FolderSpec {
  /** Name used in deck ids and tool arguments. */
  key: string;
  base: "decks" | "res";
  path: string;
  /** Whether forge_deck_save may write here. */
  writable: boolean;
  about: string;
}

/** The folders Forge offers decks from, in the order a listing shows them. */
export const FOLDERS: FolderSpec[] = [
  { key: "constructed", base: "decks", path: "constructed", writable: true, about: "Your constructed decks" },
  { key: "commander", base: "decks", path: "commander", writable: true, about: "Your Commander decks" },
  { key: "brawl", base: "decks", path: "brawl", writable: true, about: "Your Brawl decks" },
  { key: "oathbreaker", base: "decks", path: "oathbreaker", writable: true, about: "Your Oathbreaker decks" },
  { key: "tiny_leaders", base: "decks", path: "tiny_leaders", writable: true, about: "Your Tiny Leaders decks" },
  { key: "network-events", base: "decks", path: "network-events", writable: true, about: "Pools from network drafts and sealed events" },
  { key: "draft", base: "decks", path: "draft", writable: false, about: "Decks from local drafts, one folder per draft" },
  { key: "sealed", base: "decks", path: "sealed", writable: false, about: "Decks from local sealed events" },
  { key: "net", base: "decks", path: "net", writable: true, about: "Net decks, one folder per category" },
  { key: "precons", base: "res", path: "quest/precons", writable: false, about: "Preconstructed decks that ship with Forge" },
  { key: "commander-precons", base: "res", path: "quest/commanderprecons", writable: false, about: "Commander preconstructed decks that ship with Forge" },
  { key: "quest-duels", base: "res", path: "quest/duels", writable: false, about: "Quest opponent decks that ship with Forge" },
  { key: "cube", base: "res", path: "cube", writable: true, about: "Cube lists for drafting" },
];

export interface DeckSummary {
  /** `<folder>/<path under it, without .dck>`. Pass it to forge_lobby_deck. */
  id: string;
  folder: string;
  name: string;
  /** Cards in the main deck. */
  main: number;
  sideboard: number;
  commander: string[];
  /** Colours of the nonland cards, in WUBRG order. Null without FORGE_HOME. */
  colors: string | null;
  description?: string;
  tags?: string;
}

export interface DeckDetail extends DeckSummary {
  path: string;
  cards: Partial<Record<Section, { count: number; name: string }[]>>;
  dck: string;
}

export interface ListOptions {
  folder?: string;
  query?: string;
  colors?: string;
  limit?: number;
  offset?: number;
}

export interface SaveOptions {
  name?: string;
  format?: string;
  folder?: string;
  subfolder?: string;
  overwrite?: boolean;
  allowUnknown?: boolean;
  dryRun?: boolean;
}

export interface SaveResult extends DeckSummary {
  saved: boolean;
  path: string;
  /** Card names Forge does not implement. They are left out of the saved deck. */
  unknown: string[];
  notes: string[];
}

const COMMANDER_FORMATS: [RegExp, string][] = [
  [/oathbreaker/, "oathbreaker"],
  [/tiny/, "tiny_leaders"],
  [/brawl/, "brawl"],
  [/commander|edh|cedh|predh/, "commander"],
];

/** The folder a deck belongs in, from its format, its sections and its event tags. */
export function folderFor(deck: Decklist): string {
  const format = (deck.format ?? "").toLowerCase();
  if (format === "cube") return "cube";
  const byFormat = COMMANDER_FORMATS.find(([pattern]) => pattern.test(format))?.[1];
  if (byFormat) return byFormat;
  if (deck.sections.Commander?.length) return "commander";
  if (deck.meta.some(([key, value]) => key === "Tags" && /\beventId:/.test(value))) return "network-events";
  return "constructed";
}

/** A file name Forge and Windows both accept. */
export function fileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
}

interface Cached {
  mtimeMs: number;
  size: number;
  summary: DeckSummary;
}

export class DeckLibrary {
  private readonly cache = new Map<string, Cached>();
  private cardIndex?: CardIndex | null;
  private editionCodes?: Editions;

  constructor(private readonly dirs: ForgeDirs = forgeDirs()) {}

  /** Null when `FORGE_HOME` is not set or holds no card scripts. */
  cards(): CardIndex | null {
    if (this.cardIndex === undefined) {
      const index = this.dirs.res ? loadCardIndex(join(this.dirs.res, "cardsfolder"), this.dirs.customCards) : undefined;
      this.cardIndex = index && index.size > 0 ? index : null;
      for (const [flavor, name] of this.editions()?.flavorNames ?? []) this.cardIndex?.alias(flavor, name);
    }
    return this.cardIndex;
  }

  private editions(): Editions | undefined {
    if (!this.dirs.res) return undefined;
    return (this.editionCodes ??= loadEditions(join(this.dirs.res, "editions")));
  }

  folderPath(key: string): string | undefined {
    const spec = FOLDERS.find((f) => f.key === key);
    if (!spec) return undefined;
    if (spec.base === "decks") return join(this.dirs.decks, spec.path);
    return this.dirs.res ? join(this.dirs.res, spec.path) : undefined;
  }

  private files(key: string): string[] {
    const root = this.folderPath(key);
    if (!root || !existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.toLowerCase().endsWith(".dck")) out.push(join(dir, entry.name));
      }
    };
    walk(root);
    return out.sort((a, b) => a.localeCompare(b));
  }

  private summarize(key: string, path: string, deck: Decklist): DeckSummary {
    const id = `${key}/${relative(this.folderPath(key)!, path).split(sep).join("/").replace(/\.dck$/i, "")}`;
    const cards = this.cards();
    const meta = new Map(deck.meta);
    return {
      id,
      folder: key,
      name: deck.name || id.slice(id.lastIndexOf("/") + 1),
      main: countCards(deck.sections.Main),
      sideboard: countCards(deck.sections.Sideboard),
      commander: (deck.sections.Commander ?? []).map((e) => e.name),
      colors: cards ? deckColors(deck, cards) : null,
      description: meta.get("Description") || undefined,
      tags: meta.get("Tags") || undefined,
    };
  }

  /** Summaries of the given decks, reading the files that are new or changed since the last call, 64 at a time. */
  private async summaries(scope: [string, string][]): Promise<DeckSummary[]> {
    const out = new Array<DeckSummary>(scope.length);
    let next = 0;
    const worker = async () => {
      while (next < scope.length) {
        const i = next++;
        const [key, path] = scope[i];
        const stat = statSync(path);
        const hit = this.cache.get(path);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          out[i] = hit.summary;
          continue;
        }
        const summary = this.summarize(key, path, parseDck(await readFile(path, "utf8")));
        this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
        out[i] = summary;
      }
    };
    await Promise.all(Array.from({ length: 64 }, worker));
    return out;
  }

  /** Deck counts per folder, and the decks that match the filters. */
  async list(opts: ListOptions = {}): Promise<{ folders: { folder: string; decks: number; writable: boolean; about: string }[]; total: number; decks: DeckSummary[] }> {
    if (opts.folder && !FOLDERS.some((f) => f.key === opts.folder)) {
      throw new Error(`No deck folder '${opts.folder}'. Folders: ${FOLDERS.map((f) => f.key).join(", ")}`);
    }
    const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const colors = opts.colors === undefined ? undefined : [...opts.colors.toUpperCase()].filter((c) => "WUBRG".includes(c)).sort().join("");
    const folders = [];
    const scope: [string, string][] = [];
    for (const spec of FOLDERS) {
      const files = this.files(spec.key);
      folders.push({ folder: spec.key, decks: files.length, writable: spec.writable, about: spec.about });
      if (!opts.folder || opts.folder === spec.key) for (const path of files) scope.push([spec.key, path]);
    }
    const offset = opts.offset ?? 0;
    const page = <T>(all: T[]): T[] => all.slice(offset, offset + (opts.limit ?? 40));
    if (words.length === 0 && colors === undefined) {
      // Nothing to filter on: read only the decks on this page.
      return { folders, total: scope.length, decks: await this.summaries(page(scope)) };
    }
    const matches = (await this.summaries(scope)).filter((s) => {
        const text = `${s.id} ${s.name} ${s.commander.join(" ")}`.toLowerCase();
      return words.every((w) => text.includes(w)) && (colors === undefined || [...(s.colors ?? "?")].sort().join("") === colors);
    });
    return { folders, total: matches.length, decks: page(matches) };
  }

  /** The file a deck id names. Rejects ids that leave the folder. */
  pathOf(id: string): string {
    const slash = id.indexOf("/");
    const root = this.folderPath(slash < 0 ? "" : id.slice(0, slash));
    if (!root) throw new Error(`No deck '${id}'. Deck ids come from forge_decks and start with a folder name.`);
    const path = resolve(root, `${id.slice(slash + 1)}.dck`);
    if (!path.startsWith(resolve(root) + sep)) throw new Error(`No deck '${id}'.`);
    if (!existsSync(path)) throw new Error(`No deck '${id}'. List the folder with forge_decks.`);
    return path;
  }

  read(id: string): DeckDetail {
    const path = this.pathOf(id);
    const dck = readFileSync(path, "utf8");
    const deck = parseDck(dck);
    const cards: DeckDetail["cards"] = {};
    for (const [section, entries] of Object.entries(deck.sections) as [Section, Entry[]][]) {
      cards[section] = entries.map((e) => ({ count: e.count, name: e.name }));
    }
    return { ...this.summarize(id.slice(0, id.indexOf("/")), path, deck), path, cards, dck };
  }

  /** The deck with Forge's card names and set codes, and the names Forge does not implement. Unchanged without a card list. */
  resolve(deck: Decklist): { deck: Decklist; unknown: string[] } {
    const cards = this.cards();
    return cards ? resolveNames(deck, cards, this.editions()) : { deck: { ...deck }, unknown: [] };
  }

  /** Checks a deck against Forge's cards and writes it to the folder it belongs in. */
  save(input: Decklist, opts: SaveOptions = {}): SaveResult {
    const notes: string[] = [];
    const { deck, unknown } = this.resolve({ ...input, name: opts.name ?? input.name, format: opts.format ?? input.format });
    if (!this.cards()) notes.push("Card names were not checked: FORGE_HOME is not set, so Forge's card list could not be read.");
    const name = fileName(deck.name ?? "");
    if (!name) throw new Error("The deck has no name. Pass `name`.");
    deck.name = deck.name!.trim();

    const key = opts.folder ?? folderFor(deck);
    const spec = FOLDERS.find((f) => f.key === key);
    if (!spec) throw new Error(`No deck folder '${key}'. Folders: ${FOLDERS.map((f) => f.key).join(", ")}`);
    if (!spec.writable) throw new Error(`Decks cannot be saved to '${key}'. Writable folders: ${FOLDERS.filter((f) => f.writable).map((f) => f.key).join(", ")}`);
    const root = this.folderPath(key);
    if (!root) throw new Error(`'${key}' is inside the Forge install folder. Set FORGE_HOME to save there.`);
    const sub = (opts.subfolder ?? "").split(/[\\/]+/).map(fileName).filter(Boolean);
    const path = join(root, ...sub, `${name}.dck`);

    const total = countCards(deck.sections.Main) + countCards(deck.sections.Sideboard) + countCards(deck.sections.Commander);
    if (total === 0) throw new Error("No cards found in the deck text.");
    const summary = this.summarize(key, path, deck);
    const result = (saved: boolean): SaveResult => ({ ...summary, saved, path, unknown, notes });

    if (unknown.length > 0 && !opts.allowUnknown) {
      notes.push("Not saved: Forge does not implement the cards in `unknown`. Fix the names, or pass allowUnknown to save without them.");
      return result(false);
    }
    if (unknown.length > 0) notes.push("Saved without the cards in `unknown`.");
    if (existsSync(path) && !opts.overwrite) {
      notes.push("Not saved: a deck with that name is already in the folder. Pass another `name`, or overwrite.");
      return result(false);
    }
    if (opts.dryRun) {
      notes.push("Dry run: nothing written.");
      return result(false);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toDck(deck), "utf8");
    if (key === "cube") {
      // Forge lists a cube for drafting only when res/draft holds a definition that names it.
      const draft = join(this.dirs.res!, "draft", `${name}.draft`);
      if (!existsSync(draft) || opts.overwrite) {
        writeFileSync(draft, `Name:${deck.name}\nDeckFile:${deck.name}\nSingleton:True\n\nBooster: 15 Any\nNumPacks: 3\nNumPlayers: 8\n`, "utf8");
        notes.push(`Wrote the draft definition ${draft}: 3 packs of 15 for 8 players.`);
      }
    }
    notes.push("Forge reads its deck folders when it starts. forge_lobby_deck takes this id now; the Forge deck screens show the deck after a restart.");
    return result(true);
  }
}

let shared: DeckLibrary | undefined;

/** One library per process, so the card index and deck summaries are read once. */
export function sharedLibrary(): DeckLibrary {
  return (shared ??= new DeckLibrary());
}
