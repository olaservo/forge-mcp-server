import { decodeEntities } from "./decklist.js";
import { fetchText, type FetchText } from "./sites.js";

export interface SearchInput {
  query: string;
  format?: string;
  site?: string;
  limit: number;
}

/** One deck a site found. `url` is one forge_deck_save takes. */
export interface DeckHit {
  name: string;
  url: string;
  format?: string;
  colors?: string;
  author?: string;
  event?: string;
  date?: string;
  note?: string;
}

export interface SiteHits {
  site: string;
  /** How many decks the site says match, where it says. */
  total?: number;
  results: DeckHit[];
  /** Why the site has no results: it was skipped, or it did not answer. */
  note?: string;
}

/** How a search reaches the sites. Tests pass their own. */
export interface SearchIo {
  get: FetchText;
  sleep: (ms: number) => Promise<void>;
}

const live: SearchIo = { get: fetchText, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

interface SearchSite {
  name: string;
  /** Null when the site has no decks of that format. */
  search: (input: SearchInput, io: SearchIo) => Promise<Omit<SiteHits, "site"> | null>;
}

const formatKey = (format: string | undefined): string | undefined => format?.trim().toLowerCase() || undefined;

// The format codes of MTGTop8's search form.
const MTGTOP8_FORMATS: Record<string, string> = {
  standard: "ST",
  pioneer: "PI",
  modern: "MO",
  legacy: "LE",
  vintage: "VI",
  pauper: "PAU",
  premodern: "PREM",
  explorer: "EXP",
  historic: "HI",
  alchemy: "ALCH",
  cedh: "cEDH",
};

// mtgtop8.com/robots.txt asks for 5 seconds between requests.
const MTGTOP8_DELAY = 5000;
let mtgtop8Free = 0;

const MTGTOP8_ROW =
  /<a href=(event\?e=\d+&d=\d+[^ >]*)>([^<]*)<\/a><\/td>\s*<td class=G12><a class=player[^>]*>([^<]*)<\/a><\/td>\s*<td class=S12>([^<]*)<\/td>\s*<td class=S11><a href=[^>]*>([^<]*)<\/a><\/td>[\s\S]*?<td class=S12 align=center>([^<]*)<\/td>\s*<td class=S11>(\d\d)\/(\d\d)\/(\d\d)<\/td>/g;

const mtgtop8: SearchSite = {
  name: "MTGTop8",
  async search({ query, format, limit }, io) {
    const key = formatKey(format);
    const code = key ? MTGTOP8_FORMATS[key] : undefined;
    if (key && !code) return null;
    const page = async (field: "deck_titre" | "cards") => {
      const wait = mtgtop8Free - Date.now();
      if (wait > 0) await io.sleep(wait);
      mtgtop8Free = Date.now() + MTGTOP8_DELAY;
      const params = new URLSearchParams({ [field]: query, ...(code ? { format: code } : {}), ...(field === "cards" ? { MD_check: "1" } : {}) });
      return io.get(`https://mtgtop8.com/search?${params}`, "latin1");
    };
    // Deck names first, then decks that play a card of that name.
    let html = await page("deck_titre");
    let byCard = false;
    if (!html.includes("<a href=event?e=")) {
      html = await page("cards");
      byCard = true;
    }
    const results: DeckHit[] = [];
    for (const m of html.matchAll(MTGTOP8_ROW)) {
      if (results.length >= limit) break;
      results.push({
        name: decodeEntities(m[2]).trim(),
        url: `https://mtgtop8.com/${m[1]}`,
        format: m[4].trim().toLowerCase(),
        author: decodeEntities(m[3]).trim(),
        event: `${decodeEntities(m[5]).trim()}, place ${m[6].trim()}`,
        date: `20${m[9]}-${m[8]}-${m[7]}`,
        ...(byCard ? { note: `plays ${query}` } : {}),
      });
    }
    const total = /(\d+) decks matching/.exec(html)?.[1];
    return { total: total ? Number(total) : results.length, results };
  },
};

// AetherHub's format numbers. The Arena formats are the best-of-three lists.
const AETHERHUB_FORMATS: Record<string, number> = {
  standard: 1,
  modern: 2,
  commander: 3,
  legacy: 4,
  vintage: 5,
  pauper: 9,
  brawl: 10,
  limited: 11,
  pioneer: 17,
  historic: 18,
  "historic brawl": 19,
  alchemy: 21,
  explorer: 23,
  oathbreaker: 24,
  timeless: 26,
};

const AETHERHUB_COLUMNS = ["name", "color", "tags", "rarity", "price", "views", "exports", "updated", "updatedhidden", "popularity"];

interface AetherHubDeck {
  id: number;
  name: string;
  url: string;
  type?: string;
  username?: string;
  player?: string | null;
  placed?: string | null;
  color?: number[];
  updated?: number;
}

const aetherhub: SearchSite = {
  name: "AetherHub",
  async search({ query, format, limit }, io) {
    const key = formatKey(format);
    const id = key ? AETHERHUB_FORMATS[key] : undefined;
    if (key && id === undefined) return null;
    // The request the site's deck table sends: column 0 searches deck and user names, the table search
    // searches cards, and column 7 is the age limit in days, of which 365 is the longest the site offers.
    const page = async (name: string, cards: string) => {
      const filters: Record<number, string> = { 0: name, 7: "365" };
      const body = {
        draw: 1,
        columns: AETHERHUB_COLUMNS.map((column, i) => ({ data: column, name: column, searchable: true, orderable: true, search: { value: filters[i] ?? "", regex: false } })),
        order: [{ column: AETHERHUB_COLUMNS.indexOf("popularity"), dir: "desc" }],
        start: 0,
        // The site's own page size. A request for 3 rows came back empty where one for 5 did not (2026-11-21).
        length: 40,
        search: { value: cards, regex: false },
      };
      const url = `https://aetherhub.com/Meta/FetchMetaListAdv${id === undefined ? "" : `?formatId=${id}`}`;
      return JSON.parse(await io.get(url, "utf8", JSON.stringify(body))) as { recordsFiltered?: number; metadecks?: AetherHubDeck[] };
    };
    let data = await page(query, "");
    let byCard = false;
    // Column 0 also matches user names, so keep the decks whose own name has every word of the query.
    const words = query.toLowerCase().split(/\s+/);
    const found = data.metadecks ?? [];
    let decks = found.filter((d) => words.every((w) => d.name.toLowerCase().includes(w)));
    const dropped = decks.length < found.length;
    if (decks.length === 0) {
      data = await page("", query);
      decks = data.metadecks ?? [];
      byCard = true;
    }
    const results = decks.slice(0, limit).map((d): DeckHit => {
      const colors = [..."WUBRG"].filter((_, i) => (d.color?.[i] ?? 0) > 0).join("");
      return {
        name: d.name,
        // forge_deck_save needs the deck number, which the site leaves out of some deck URLs.
        url: d.url.endsWith(`-${d.id}`) ? `https://aetherhub.com${d.url}` : `https://aetherhub.com/Deck/Public/${d.id}`,
        ...(d.type ? { format: d.type.toLowerCase() } : {}),
        ...(d.color ? { colors } : {}),
        author: d.player || d.username,
        ...(d.placed ? { event: `place ${d.placed}` } : {}),
        ...(d.updated ? { date: new Date(d.updated).toISOString().slice(0, 10) } : {}),
        ...(byCard ? { note: `plays ${query}` } : {}),
      };
    });
    // The site's count includes the user-name matches, so it is left out when any were dropped.
    return { ...(dropped && !byCard ? {} : { total: data.recordsFiltered ?? results.length }), results };
  },
};

const EDHREC_FORMATS = new Set(["commander", "edh", "cedh"]);

const edhrec: SearchSite = {
  name: "EDHREC",
  async search({ query, format, limit }, io) {
    const key = formatKey(format);
    if (key && !EDHREC_FORMATS.has(key)) return null;
    const words = query.trim().split(/\s+/);
    // The site's search box finds commanders by name. Words it cannot place at the end of the query are read as a theme.
    let commanders: { label: string; url: string }[] = [];
    let used = words.length;
    for (; used >= Math.max(1, words.length - 2); used--) {
      const found = JSON.parse(await io.get(`https://edhrec.com/api/typeahead/?${new URLSearchParams({ q: words.slice(0, used).join(" ") })}`)) as { label: string; url: string }[];
      commanders = found.filter((c) => c.url.startsWith("/commanders/"));
      if (commanders.length > 0) break;
    }
    const slug = (c: { url: string }) => c.url.slice("/commanders/".length);
    const results: DeckHit[] = [];
    const theme = words.slice(used).map((w) => w.toLowerCase());
    if (commanders.length > 0 && theme.length > 0) {
      const top = commanders[0];
      const data = JSON.parse(await io.get(`https://json.edhrec.com/pages/commanders/${slug(top)}.json`)) as {
        panels?: { taglinks?: { count: number; slug: string; value: string }[] };
      };
      for (const tag of data.panels?.taglinks ?? []) {
        if (!theme.every((w) => tag.value.toLowerCase().includes(w) || tag.slug.includes(w))) continue;
        results.push({
          name: `Average deck for ${top.label}, ${tag.value}`,
          url: `https://edhrec.com/average-decks/${slug(top)}/${tag.slug}`,
          format: "commander",
          note: `${tag.count} decks`,
        });
      }
    }
    for (const c of commanders) results.push({ name: `Average deck for ${c.label}`, url: `https://edhrec.com/average-decks/${slug(c)}`, format: "commander" });
    return { results: results.slice(0, limit) };
  },
};

const SEARCH_SITES: SearchSite[] = [mtgtop8, aetherhub, edhrec];

export const SEARCH_SITE_NAMES = SEARCH_SITES.map((s) => s.name) as [string, ...string[]];

/** Searches the deck sites that have a search and returns each site's results in the site's own order. */
export async function searchDecks(input: SearchInput, io: SearchIo = live): Promise<{ query: string; sites: SiteHits[] }> {
  const query = input.query.trim();
  if (!query) throw new Error("Give a `query`: an archetype, a deck name, a commander or a card.");
  const chosen = SEARCH_SITES.filter((s) => !input.site || s.name === input.site);
  const sites = await Promise.all(
    chosen.map(async (site): Promise<SiteHits> => {
      try {
        const hits = await site.search({ ...input, query }, io);
        return hits ? { site: site.name, ...hits } : { site: site.name, results: [], note: `${site.name} has no ${input.format} decks to search.` };
      } catch (e) {
        return { site: site.name, results: [], note: `${site.name} did not answer the search (${e instanceof Error ? e.message : String(e)}).` };
      }
    }),
  );
  return { query, sites };
}
