import { get as httpsGet } from "node:https";
import { addEntry, decodeEntities, emptyDecklist, parseDck, parseText, type Decklist, type Section } from "./decklist.js";

/** Fetches a URL and returns its body as text. Tests pass their own. */
export type FetchText = (url: string, encoding?: "utf8" | "latin1") => Promise<string>;

interface Site {
  name: string;
  /** Host names this site answers on, without `www.`. */
  hosts: string[];
  /** Other hosts the fetch goes to. */
  apiHosts?: string[];
  /** What a deck URL looks like, for the error message when one does not match. */
  example: string;
  /** Set when the site turns away requests that do not come from a browser. */
  blocked?: string;
  fetch?: (url: URL, get: FetchText) => Promise<Decklist>;
}

const title = (html: string): string | undefined => {
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : undefined;
};

const words = (slug: string): string =>
  slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

const noMatch = (site: Site): Error => new Error(`Not a ${site.name} deck URL. Expected something like ${site.example}`);

const MOXFIELD_BOARDS: [string, Section][] = [
  ["commanders", "Commander"],
  ["signatureSpells", "Commander"],
  ["mainboard", "Main"],
  ["sideboard", "Sideboard"],
  ["companions", "Sideboard"],
  ["planes", "Planes"],
  ["schemes", "Schemes"],
  ["attractions", "Attractions"],
  ["stickers", "Stickers"],
  ["contraptions", "Contraptions"],
];

interface MoxfieldCard {
  quantity: number;
  card: { name: string; set?: string };
}

const moxfield: Site = {
  name: "Moxfield",
  hosts: ["moxfield.com"],
  apiHosts: ["api2.moxfield.com"],
  example: "https://moxfield.com/decks/<id>",
  async fetch(url, get) {
    const id = /^\/decks\/([\w-]+)/.exec(url.pathname)?.[1];
    if (!id) throw noMatch(this);
    const data = JSON.parse(await get(`https://api2.moxfield.com/v3/decks/all/${id}`)) as {
      name: string;
      format?: string;
      boards: Record<string, { cards?: Record<string, MoxfieldCard> }>;
    };
    const deck = emptyDecklist();
    deck.name = data.name;
    deck.format = data.format;
    for (const [board, section] of MOXFIELD_BOARDS) {
      for (const c of Object.values(data.boards?.[board]?.cards ?? {})) {
        addEntry(deck, section, { count: c.quantity, name: c.card.name, set: c.card.set });
      }
    }
    return deck;
  },
};

// The formats Archidekt numbers 1 to 6. Other numbers are left unnamed.
const ARCHIDEKT_FORMATS = ["", "standard", "modern", "commander", "legacy", "vintage", "pauper"];

const archidekt: Site = {
  name: "Archidekt",
  hosts: ["archidekt.com"],
  example: "https://archidekt.com/decks/<number>/<name>",
  async fetch(url, get) {
    const id = /^\/decks\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) throw noMatch(this);
    const data = JSON.parse(await get(`https://archidekt.com/api/decks/${id}/`)) as {
      name: string;
      deckFormat?: number;
      categories?: { name: string; includedInDeck: boolean; isPremier: boolean }[];
      cards: { quantity: number; categories?: string[]; card: { oracleCard: { name: string }; edition?: { editioncode?: string } } }[];
    };
    const categories = new Map((data.categories ?? []).map((c) => [c.name, c]));
    const deck = emptyDecklist();
    deck.name = data.name;
    deck.format = ARCHIDEKT_FORMATS[data.deckFormat ?? 0] || undefined;
    for (const c of data.cards) {
      // A card's first category decides where it sits.
      const first = c.categories?.[0];
      const category = first ? categories.get(first) : undefined;
      let section: Section = "Main";
      if (first === "Commander" || category?.isPremier) section = "Commander";
      else if (first === "Sideboard") section = "Sideboard";
      else if (category && !category.includedInDeck) continue;
      addEntry(deck, section, { count: c.quantity, name: c.card.oracleCard.name, set: c.card.edition?.editioncode });
    }
    return deck;
  },
};

const aetherhub: Site = {
  name: "AetherHub",
  hosts: ["aetherhub.com"],
  example: "https://aetherhub.com/Deck/<name>-<number>",
  async fetch(url, get) {
    const m = /^\/Deck\/(?:Public\/)?(?:(.*)-)?(\d+)\/?$/i.exec(url.pathname);
    if (!m) throw noMatch(this);
    const data = JSON.parse(await get(`https://aetherhub.com/Deck/FetchMtgaDeckJson?deckId=${m[2]}&langId=0&simple=false`)) as {
      convertedDeck: { quantity: number | null; name: string; set?: string }[];
    };
    // Section headings arrive as rows with no quantity.
    const lines = data.convertedDeck.map((c) => (c.quantity === null ? `\n${c.name}` : `${c.quantity} ${c.name}${c.set ? ` (${c.set})` : ""}`));
    const deck = parseText(lines.join("\n"));
    deck.name = m[1] ? words(m[1]) : `AetherHub ${m[2]}`;
    return deck;
  },
};

const edhrec: Site = {
  name: "EDHREC",
  hosts: ["edhrec.com"],
  apiHosts: ["json.edhrec.com"],
  example: "https://edhrec.com/average-decks/<commander>",
  async fetch(url, get) {
    const slug = /^\/(?:average-decks|commanders)\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/.exec(url.pathname)?.[1];
    if (!slug) throw noMatch(this);
    const data = JSON.parse(await get(`https://json.edhrec.com/pages/average-decks/${slug}.json`)) as {
      header?: string;
      deck: { commander_v2?: [string, number][]; cards: Record<string, [string, number][]> };
    };
    const deck = emptyDecklist();
    deck.name = data.header ?? `Average Deck ${words(slug)}`;
    deck.format = "commander";
    for (const [name, count] of data.deck.commander_v2 ?? []) addEntry(deck, "Commander", { count, name });
    for (const list of Object.values(data.deck.cards)) {
      for (const [name, count] of list) addEntry(deck, "Main", { count, name });
    }
    return deck;
  },
};

const mtgtop8: Site = {
  name: "MTGTop8",
  hosts: ["mtgtop8.com"],
  example: "https://mtgtop8.com/event?e=<event>&d=<deck>",
  async fetch(url, get) {
    const id = url.searchParams.get("d");
    if (!id || !/^\d+$/.test(id)) throw noMatch(this);
    const deck = parseText(await get(`https://mtgtop8.com/mtgo?d=${id}`, "latin1"));
    const page = await get(`https://mtgtop8.com/event${url.search}`, "latin1").catch(() => "");
    deck.name = title(page)?.replace(/\s*@\s*mtgtop8\.com.*$/i, "") || `MTGTop8 ${id}`;
    return deck;
  },
};

const mtgdecks: Site = {
  name: "MTGDecks",
  hosts: ["mtgdecks.net"],
  example: "https://mtgdecks.net/<Format>/<name>-decklist-by-<player>-<number>",
  async fetch(url, get) {
    const m = /^\/([A-Za-z-]+)\/([a-z0-9-]+-\d+)\/?$/.exec(url.pathname);
    if (!m) throw noMatch(this);
    const page = await get(`https://mtgdecks.net/${m[1]}/${m[2]}`);
    const text = /<textarea id="arena_deck"[^>]*>([\s\S]*?)<\/textarea>/.exec(page)?.[1];
    if (!text) throw new Error("No decklist found on that MTGDecks page.");
    const deck = parseText(decodeEntities(text));
    deck.name = title(page)?.replace(/\s*[•|].*$/, "") || words(m[2]);
    deck.format = m[1].toLowerCase();
    return deck;
  },
};

const cubecobra: Site = {
  name: "Cube Cobra",
  hosts: ["cubecobra.com"],
  example: "https://cubecobra.com/cube/overview/<id>",
  async fetch(url, get) {
    const id = /^\/cube\/(?:\w+\/)+([\w-]+)\/?$/.exec(url.pathname)?.[1];
    if (!id) throw noMatch(this);
    const deck = parseDck(await get(`https://cubecobra.com/cube/download/forge/${id}`));
    deck.format = "cube";
    return deck;
  },
};

const BLOCKED = "turns away requests that do not come from a browser. Open the deck page, copy its text export, and pass that as `text`.";

export const SITES: Site[] = [
  moxfield,
  archidekt,
  aetherhub,
  edhrec,
  mtgtop8,
  mtgdecks,
  cubecobra,
  { name: "MTGGoldfish", hosts: ["mtggoldfish.com"], example: "https://www.mtggoldfish.com/deck/<number>", blocked: BLOCKED },
  { name: "TappedOut", hosts: ["tappedout.net"], example: "https://tappedout.net/mtg-decks/<name>/", blocked: BLOCKED },
];

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, "");

function siteFor(url: URL): Site | undefined {
  return SITES.find((s) => s.hosts.includes(bareHost(url.hostname)));
}

const ALLOWED_HOSTS = new Set(SITES.flatMap((s) => [...s.hosts, ...(s.apiHosts ?? [])]));
const MAX_BYTES = 8 * 1024 * 1024;

interface Reply {
  status: number;
  location?: string;
  body: Buffer;
}

// node:https, because Moxfield, AetherHub and MTGDecks answer 403 to Node's fetch (observed 2026-11-13).
const request = (url: URL): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { headers: { "user-agent": "forge-mcp-server (deck import)", accept: "application/json, text/plain, text/html;q=0.8" }, timeout: 25_000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error(`${url.hostname} sent more than ${MAX_BYTES} bytes`));
          else chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${url.hostname} did not answer in time`)));
    req.on("error", reject);
  });

/** HTTPS GET limited to the deck sites, following redirects only between them. */
export const fetchText: FetchText = async (url, encoding = "utf8") => {
  let next = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(next);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(bareHost(u.hostname))) throw new Error(`Refusing to fetch ${u.origin}: not a supported deck site.`);
    const res = await request(u);
    if (res.status >= 300 && res.status < 400 && res.location) {
      next = new URL(res.location, u).toString();
      continue;
    }
    if (res.status !== 200) throw new Error(`${u.hostname} answered ${res.status} for ${u.pathname}`);
    return res.body.toString(encoding);
  }
  throw new Error(`Too many redirects from ${url}`);
};

/** Fetches the deck a deck-site URL points to. */
export async function fetchDeck(link: string, get: FetchText = fetchText): Promise<Decklist & { site: string }> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`Not a URL: ${link}`);
  }
  const site = siteFor(url);
  if (!site) {
    const names = SITES.filter((s) => s.fetch).map((s) => s.name).join(", ");
    throw new Error(`${url.hostname} is not a supported deck site (${names}). Copy the deck's text export and pass that as \`text\`.`);
  }
  if (!site.fetch) throw new Error(`${site.name} ${site.blocked}`);
  const deck = await site.fetch(url, get);
  if (!deck.meta.some(([k]) => k === "Source URL")) deck.meta.push(["Source URL", link]);
  return { ...deck, site: site.name };
}
