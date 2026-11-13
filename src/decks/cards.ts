import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** What the deck tools need to know about a card Forge implements. */
export interface CardInfo {
  /** The name Forge uses in a deck file: the front face, or `Left // Right` for a split card. */
  name: string;
  /** Colours in WUBRG order, empty for colourless. */
  colors: string;
  land: boolean;
}

const WUBRG = "WUBRG";
const COLOR_WORDS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };

/** Lookup key: case, accents and apostrophe style do not matter, as in Forge's own card lookup. */
export function cardKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function sortColors(colors: Iterable<string>): string {
  const set = new Set(colors);
  return [...WUBRG].filter((c) => set.has(c)).join("");
}

function faceColors(manaCost: string | undefined, colors: string | undefined): string {
  if (colors !== undefined) {
    return sortColors(colors.split(",").map((w) => COLOR_WORDS[w.trim().toLowerCase()] ?? ""));
  }
  const found: string[] = [];
  for (const symbol of (manaCost ?? "").split(/\s+/)) {
    if (!/^[WUBRGP0-9XCS]+$/.test(symbol)) continue;
    for (const ch of symbol) if (WUBRG.includes(ch)) found.push(ch);
  }
  return sortColors(found);
}

interface Face {
  name?: string;
  manaCost?: string;
  colors?: string;
  types?: string;
}

/** The cards Forge implements, read from its card scripts. */
export class CardIndex {
  private readonly cards = new Map<string, CardInfo>();
  private readonly faces = new Map<string, CardInfo>();

  get size(): number {
    return this.cards.size;
  }

  /** Adds one card script (a file from `res/cardsfolder`). */
  addScript(script: string): void {
    const faces: Face[] = [{}];
    let mode: string | undefined;
    for (const line of script.split(/\r?\n/)) {
      if (line === "ALTERNATE" || line.startsWith("SPECIALIZE:")) {
        faces.push({});
        continue;
      }
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      const face = faces[faces.length - 1];
      if (key === "Name" && face.name === undefined) face.name = value;
      else if (key === "ManaCost" && face.manaCost === undefined) face.manaCost = value;
      else if (key === "Colors" && face.colors === undefined) face.colors = value;
      else if (key === "Types" && face.types === undefined) face.types = value;
      else if (key === "AlternateMode") mode = value;
    }
    const [front, back] = faces;
    if (!front.name) return;
    const split = mode === "Split" && back?.name;
    const info: CardInfo = {
      name: split ? `${front.name} // ${back.name}` : front.name,
      colors: split
        ? sortColors(faceColors(front.manaCost, front.colors) + faceColors(back.manaCost, back.colors))
        : faceColors(front.manaCost, front.colors),
      land: /\bLand\b/.test(front.types ?? ""),
    };
    this.cards.set(cardKey(info.name), info);
    for (const face of faces) {
      if (face.name && !this.faces.has(cardKey(face.name))) this.faces.set(cardKey(face.name), info);
    }
  }

  /** Lets `find` answer to another name for a card, such as the flavour name of one printing. */
  alias(name: string, card: string): void {
    const target = this.cards.get(cardKey(card));
    if (target && !this.faces.has(cardKey(name))) this.faces.set(cardKey(name), target);
  }

  /**
   * Finds a card by any name a deck site gives it: the Forge name, one face, or both faces joined
   * with one or two slashes.
   */
  find(name: string): CardInfo | undefined {
    const key = cardKey(name);
    const direct = this.cards.get(key) ?? this.faces.get(key);
    if (direct) return direct;
    if (!key.includes("/")) return undefined;
    const parts = key.split(/\s*\/+\s*/).filter(Boolean);
    return this.cards.get(parts.join(" // ")) ?? this.cards.get(parts[0]) ?? this.faces.get(parts[0]);
  }
}

/** Entries of a zip archive, read from its central directory. */
export function* zipEntries(buf: Buffer): Generator<{ name: string; data: () => Buffer }> {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(end + 10);
  if (count === 0xffff) throw new Error("zip64 archives are not supported");
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    yield {
      name,
      data: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        return method === 0 ? raw : inflateRawSync(raw);
      },
    };
  }
}

function addFolder(index: CardIndex, dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) addFolder(index, path);
    else if (entry.name.endsWith(".txt")) index.addScript(readFileSync(path, "utf8"));
    else if (entry.name.endsWith(".zip")) {
      for (const file of zipEntries(readFileSync(path))) {
        if (file.name.endsWith(".txt")) index.addScript(file.data().toString("utf8"));
      }
    }
  }
}

/** Reads every card script under the given folders: loose `.txt` files and the release build's `cardsfolder.zip`. */
export function loadCardIndex(...dirs: string[]): CardIndex {
  const index = new CardIndex();
  for (const dir of dirs) if (existsSync(dir)) addFolder(index, dir);
  return index;
}

/**
 * Forge's edition codes. A deck line may name any of an edition's codes; `canonical` maps each to
 * the code Forge writes.
 */
export class Editions {
  private readonly codes = new Map<string, string>();
  /** Flavour names some printings carry, each with the card's real name. */
  readonly flavorNames = new Map<string, string>();

  get size(): number {
    return this.codes.size;
  }

  add(file: string): void {
    const meta: Record<string, string> = {};
    let inMeta = true;
    for (const line of file.split(/\r?\n/)) {
      if (line.startsWith("[")) inMeta = line.toLowerCase() === "[metadata]";
      const eq = line.indexOf("=");
      if (inMeta && eq > 0) meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      // A card line: number, rarity, name, artist, then options such as the flavour name.
      const flavor = /^\S+ \S+ (.+?) @.*"flavorName":\s*"([^"]+)"/.exec(line);
      if (flavor) this.flavorNames.set(flavor[2], flavor[1]);
    }
    if (!meta.Code) return;
    this.codes.set(meta.Code.toUpperCase(), meta.Code);
    for (const alias of [meta.Code2, meta.Alias, meta.ScryfallCode]) {
      if (alias && !this.codes.has(alias.toUpperCase())) this.codes.set(alias.toUpperCase(), meta.Code);
    }
  }

  canonical(code: string): string | undefined {
    return this.codes.get(code.trim().toUpperCase());
  }
}

export function loadEditions(...dirs: string[]): Editions {
  const editions = new Editions();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".txt")) editions.add(readFileSync(join(dir, name), "utf8"));
    }
  }
  return editions;
}
