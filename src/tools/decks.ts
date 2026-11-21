import { z } from "zod";
import { parseAny } from "../decks/decklist.js";
import { FOLDERS, type DeckLibrary } from "../decks/library.js";
import { searchDecks, SEARCH_SITE_NAMES, type SearchIo } from "../decks/search.js";
import { fetchDeck, SITES } from "../decks/sites.js";
import * as out from "../schemas.js";
import { readOnly, run, type RegisterTool } from "./common.js";

const folderKeys = FOLDERS.map((f) => f.key) as [string, ...string[]];
const writableKeys = FOLDERS.filter((f) => f.writable).map((f) => f.key) as [string, ...string[]];
const siteNames = SITES.filter((s) => s.fetch).map((s) => s.name).join(", ");

/** Deck tools work on Forge's folders on the server's machine and need no bridge. */
export function registerDeckTools(tool: RegisterTool, decks: DeckLibrary, search?: SearchIo): void {
  tool(
    "forge_decks",
    {
      title: "List decks",
      description:
        "The decks this seat can use, read from Forge's deck folders on the server's machine: your own decks, net decks, draft pools, " +
        "and the preconstructed and quest decks that ship with Forge. `folders` counts every folder. Narrow `decks` with `folder`, " +
        "`query` (words from the deck name, its path or its commander) and `colors` (the exact colours, such as `WU`; empty for colourless). " +
        "Net decks are listed only with `folder: \"net\"`, where `query` matches the category and file name. " +
        "Give a deck's `id` to forge_lobby_deck to play it. Pass `id` here to read that one deck's card list.",
      inputSchema: z.object({
        folder: z.enum(folderKeys).optional(),
        query: z.string().optional(),
        colors: z.string().regex(/^[WUBRGwubrg]*$/).optional(),
        id: z.string().optional().describe("Read this one deck instead of listing"),
        limit: z.number().int().min(1).max(200).default(40),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: out.DeckList,
      annotations: readOnly,
    },
    async ({ id, ...filters }) =>
      run(async () => {
        if (!id) return await decks.list(filters);
        const { path: _path, ...deck } = decks.read(id);
        return { deck };
      }),
  );

  if (process.env.FORGE_DECKS_READONLY === "1") return;

  tool(
    "forge_deck_search",
    {
      title: "Search deck sites",
      description:
        `Find decks on deck sites (${SEARCH_SITE_NAMES.join(", ")}) by \`query\`: an archetype or deck name, a commander, or a card. ` +
        "Each site answers in its own order: MTGTop8 and AetherHub by deck name and, when no name matches, by decks that play a card of that name; " +
        "EDHREC by commander, with a theme after the name (`atraxa infect`). `format` narrows the search and leaves out a site that has no such decks. " +
        "Nothing is saved: show the player the results, then give the chosen `url` to forge_deck_save. A MTGTop8 search waits 5 seconds after the one before it.",
      inputSchema: z.object({
        query: z.string().min(1).max(100),
        format: z.string().optional().describe("standard, pioneer, modern, legacy, vintage, pauper, commander and so on"),
        site: z.enum(SEARCH_SITE_NAMES).optional().describe("Search this one site"),
        limit: z.number().int().min(1).max(25).default(10).describe("Results per site"),
      }),
      outputSchema: out.DeckSearch,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => run(() => searchDecks(input, search)),
  );

  tool(
    "forge_deck_save",
    {
      title: "Save a deck",
      description:
        `Save a deck into Forge's deck folders. Give a deck page \`url\` (${siteNames}) or the deck as \`text\`: Forge .dck text, ` +
        "a plain list (`4 Lightning Bolt`, with or without Arena or Magic Online set codes and Sideboard or Commander headings), or a Magic Online .dek file. " +
        "Card names are checked against the cards Forge implements and rewritten to Forge's spelling. A deck with unknown cards is not saved unless `allowUnknown`. " +
        "The folder follows from the deck: commander, brawl, oathbreaker, tiny_leaders, cube, network-events for a pool with event tags, otherwise constructed. " +
        "`dryRun` reports the result without writing. An existing deck is replaced only with `overwrite`.",
      inputSchema: z.object({
        url: z.string().url().optional(),
        text: z.string().optional(),
        name: z.string().optional().describe("Deck name. Required for text that carries none."),
        format: z.string().optional().describe("commander, brawl, oathbreaker, tiny leaders, cube, or a constructed format"),
        folder: z.enum(writableKeys).optional().describe("Overrides the folder chosen from the deck"),
        subfolder: z.string().optional().describe("Folder under it, such as Modern, or a net deck category"),
        overwrite: z.boolean().default(false),
        allowUnknown: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      }),
      outputSchema: out.DeckSaved,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, text, ...opts }) =>
      run(async () => {
        if (!url === !text) throw new Error("Give exactly one of `url` and `text`.");
        const deck = url ? await fetchDeck(url) : parseAny(text!);
        return { ...decks.save(deck, opts), source: url ? (deck as { site?: string }).site : "text" };
      }),
  );
}
