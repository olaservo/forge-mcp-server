import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CardIndex, loadCardIndex, zipEntries } from "../src/decks/cards.js";
import { countCards, parseAny, parseDck, parseText, toDck } from "../src/decks/decklist.js";
import { DeckLibrary, fileName, folderFor } from "../src/decks/library.js";
import { fetchDeck, fetchText, type FetchText } from "../src/decks/sites.js";
import { connect, fakeBridge, forgeHome } from "./helpers.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/decks/${name}`, import.meta.url), "utf8");
const names = (entries: { count: number; name: string }[] | undefined) => (entries ?? []).map((e) => `${e.count} ${e.name}`);

/** A zip archive with deflated entries, built by hand so the reader is tested without a zip library. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, Buffer.from(name), data);
    central.push(entry, Buffer.from(name));
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("card index", () => {
  const library = new DeckLibrary(forgeHome());
  const cards = library.cards()!;

  it("finds a card by any face, with either slash style, whatever the accents and case", () => {
    expect(cards.find("delver of secrets // insectile aberration")?.name).toBe("Delver of Secrets");
    expect(cards.find("Insectile Aberration")?.name).toBe("Delver of Secrets");
    expect(cards.find("Fire/Ice")?.name).toBe("Fire // Ice");
    expect(cards.find("Fire")?.name).toBe("Fire // Ice");
    expect(cards.find("Bonecrusher Giant // Stomp")?.name).toBe("Bonecrusher Giant");
    expect(cards.find("Lim-Dul’s Vault")?.name).toBe("Lim-Dûl's Vault");
    expect(cards.find("Black Lotus")).toBeUndefined();
  });

  it("reads colours from mana costs and Colors lines, and treats a split card as both halves", () => {
    expect(cards.find("Atraxa, Praetors' Voice")?.colors).toBe("WUBG");
    expect(cards.find("Fire // Ice")?.colors).toBe("UR");
    expect(cards.find("Sol Ring")?.colors).toBe("");
    expect(cards.find("Mountain")?.land).toBe(true);
  });

  it("answers to a printing's flavour name", () => {
    expect(cards.find("Balin's Tomb")?.name).toBe("Ancient Tomb");
  });

  it("reads the release build's cardsfolder.zip", () => {
    const dirs = forgeHome();
    const archive = zip({ "b/black_lotus.txt": "Name:Black Lotus\nManaCost:0\nTypes:Artifact", "readme.md": "not a card" });
    expect([...zipEntries(archive)].map((e) => e.name)).toEqual(["b/black_lotus.txt", "readme.md"]);
    writeFileSync(join(dirs.res!, "cardsfolder", "cardsfolder.zip"), archive);
    const index: CardIndex = loadCardIndex(join(dirs.res!, "cardsfolder"));
    expect(index.find("Black Lotus")?.name).toBe("Black Lotus");
    expect(index.find("Lightning Bolt")?.name).toBe("Lightning Bolt");
  });
});

describe("deck text", () => {
  it("reads an Arena export with its name, set codes and sideboard", () => {
    const deck = parseText("About\nName Izzet Test\n\nDeck\n4 Lightning Bolt (M10) 146\n4 Fire // Ice (MH2) 290\n20 Mountain (ANA) 59\n\nSideboard\n2 Bonecrusher Giant (ELD) 115\n");
    expect(deck.name).toBe("Izzet Test");
    expect(names(deck.sections.Main)).toEqual(["4 Lightning Bolt", "4 Fire // Ice", "20 Mountain"]);
    expect(deck.sections.Main![0].set).toBe("M10");
    expect(names(deck.sections.Sideboard)).toEqual(["2 Bonecrusher Giant"]);
  });

  it("takes the cards after a blank line as the sideboard", () => {
    const deck = parseText("4 Lightning Bolt\n56 Mountain\n\n3 Fire // Ice\n");
    expect(countCards(deck.sections.Main)).toBe(60);
    expect(names(deck.sections.Sideboard)).toEqual(["3 Fire // Ice"]);
  });

  it("takes a card set apart at the end of a 100-card list as the commander", () => {
    expect(names(parseText("1 Sol Ring\n98 Island\n\n1 Atraxa, Praetors' Voice").sections.Commander)).toEqual(["1 Atraxa, Praetors' Voice"]);
    const withSideboard = parseText("1 Sol Ring\n98 Island\n\nSIDEBOARD:\n2 Lightning Bolt\n\n1 Atraxa, Praetors' Voice");
    expect(names(withSideboard.sections.Commander)).toEqual(["1 Atraxa, Praetors' Voice"]);
    expect(names(withSideboard.sections.Sideboard)).toEqual(["2 Lightning Bolt"]);
  });

  it("reads a Moxfield export, a Magic Online .dec file and a commander tag", () => {
    const moxfield = parseText("1 Sol Ring (CMM) 410 *F*\n1 Delver of Secrets // Insectile Aberration (ISD) 51\n");
    expect(names(moxfield.sections.Main)).toEqual(["1 Sol Ring", "1 Delver of Secrets // Insectile Aberration"]);
    const dec = parseText("// Deck file created with mtgtop8.com\n4 [M11] Lightning Bolt\n4 [] Fire // Ice\nSB: 2 [ELD] Bonecrusher Giant\n");
    expect(names(dec.sections.Main)).toEqual(["4 Lightning Bolt", "4 Fire // Ice"]);
    expect(names(dec.sections.Sideboard)).toEqual(["2 Bonecrusher Giant"]);
    expect(names(parseText("1 Atraxa, Praetors' Voice *CMDR*\n99 Island").sections.Commander)).toEqual(["1 Atraxa, Praetors' Voice"]);
  });

  it("drops type headings from a counted list and the maybeboard", () => {
    const deck = parseText("Creature (4)\n4 Delver of Secrets\n\nInstant (4)\n4 Lightning Bolt\n\nLand (20)\n20 Island\n\nMaybeboard\n1 Sol Ring\n");
    expect(names(deck.sections.Main)).toEqual(["4 Delver of Secrets", "4 Lightning Bolt", "20 Island"]);
    expect(deck.sections.Sideboard).toBeUndefined();
  });

  it("reads a cube list with no counts", () => {
    const deck = parseText("# mainboard\nLightning Bolt\nSol Ring\n# maybeboard\nIsland\n");
    expect(names(deck.sections.Main)).toEqual(["1 Lightning Bolt", "1 Sol Ring"]);
  });

  it("reads a Magic Online .dek file", () => {
    const deck = parseAny(
      '<?xml version="1.0"?>\n<Deck>\n<Cards CatID="1" Quantity="4" Sideboard="false" Name="Lightning Bolt" Annotation="0"/>\n<Cards CatID="2" Quantity="2" Sideboard="true" Name="Lim-D&#xFB;l&apos;s Vault"/>\n</Deck>',
    );
    expect(names(deck.sections.Main)).toEqual(["4 Lightning Bolt"]);
    expect(deck.sections.Sideboard![0].count).toBe(2);
  });

  it("keeps a .dck file's printings and its non-card sections", () => {
    const text = "[shop]\nCredits=1200\n[metadata]\nName=Bolt Precon\nDeck Type=constructed\n[Main]\n20 Mountain|M10\n4 Lightning Bolt|M10|1\n";
    expect(toDck(parseDck(text))).toBe(text);
    expect(parseAny(text).name).toBe("Bolt Precon");
  });
});

describe("deck library", () => {
  it("lists folders and filters decks by words and colours", async () => {
    const library = new DeckLibrary(forgeHome());
    const all = await library.list();
    expect(all.total).toBe(3);
    expect(all.folders.find((f) => f.folder === "precons")?.decks).toBe(1);
    expect(all.decks.map((d) => d.id)).toEqual(["constructed/Izzet Tempo", "commander/Atraxa Vault", "precons/Bolt Precon"]);
    expect(all.decks[0]).toMatchObject({ main: 32, sideboard: 2, colors: "UR" });
    expect((await library.list({ query: "atraxa" })).decks.map((d) => d.id)).toEqual(["commander/Atraxa Vault"]);
    expect((await library.list({ colors: "R" })).decks.map((d) => d.id)).toEqual(["precons/Bolt Precon"]);
    expect((await library.list({ folder: "precons", limit: 1 })).decks[0].description).toBe("Burn");
    await expect(library.list({ folder: "nope" })).rejects.toThrow(/No deck folder/);
  });

  it("reads one deck and refuses an id that leaves its folder", () => {
    const library = new DeckLibrary(forgeHome());
    const deck = library.read("precons/Bolt Precon");
    expect(deck.cards.Main).toEqual([{ count: 20, name: "Mountain" }, { count: 4, name: "Lightning Bolt" }]);
    expect(deck.dck).toContain("[shop]");
    expect(() => library.read("constructed/../commander/Atraxa Vault")).toThrow(/No deck/);
    expect(() => library.read("constructed/Missing")).toThrow(/No deck/);
  });

  it("picks the folder from the format, the sections and the event tags", () => {
    expect(folderFor(parseText("4 Lightning Bolt"))).toBe("constructed");
    expect(folderFor(parseText("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n99 Island"))).toBe("commander");
    expect(folderFor({ ...parseText("Commander\n1 Sol Ring"), format: "historicBrawl" })).toBe("brawl");
    expect(folderFor({ ...parseText("1 Sol Ring"), format: "cube" })).toBe("cube");
    expect(folderFor(parseDck("[metadata]\nName=Pool\nTags=eventId:1ca8e45b,eventFormat:BOOSTER_DRAFT\n[Sideboard]\n1 Sol Ring"))).toBe("network-events");
    expect(fileName('Who? Me: "Burn" / v2. ')).toBe("Who Me Burn v2");
  });

  it("saves with Forge's card names and set codes, merging repeated lines", () => {
    const dirs = forgeHome();
    const library = new DeckLibrary(dirs);
    const deck = parseText("3 lightning bolt (m10) 146\n1 Lightning Bolt (M10) 146\n2 Delver of Secrets // Insectile Aberration (XXX) 1\n4 Fire/Ice\n1 Balin's Tomb (ltc2)\n");
    const result = library.save(deck, { name: "Tempo: Test" });
    expect(result).toMatchObject({ saved: true, id: "constructed/Tempo Test", folder: "constructed", main: 11, unknown: [] });
    expect(readFileSync(result.path, "utf8")).toBe(
      "[metadata]\nName=Tempo: Test\n[Main]\n4 Lightning Bolt|M10\n2 Delver of Secrets\n4 Fire // Ice\n1 Ancient Tomb|LTC\n",
    );
    expect(library.read(result.id).name).toBe("Tempo: Test");
  });

  it("does not save a deck with unknown cards, or over an existing deck, unless told to", () => {
    const library = new DeckLibrary(forgeHome());
    const unknown = library.save(parseText("4 Lightning Bolt\n4 Black Lotus"), { name: "Power" });
    expect(unknown).toMatchObject({ saved: false, unknown: ["Black Lotus"] });
    expect(existsSync(unknown.path)).toBe(false);
    expect(library.save(parseText("4 Lightning Bolt\n4 Black Lotus"), { name: "Power", allowUnknown: true })).toMatchObject({ saved: true, main: 4 });
    expect(library.save(parseText("4 Lightning Bolt"), { name: "Power" }).saved).toBe(false);
    expect(library.save(parseText("4 Lightning Bolt"), { name: "Power", overwrite: true }).saved).toBe(true);
    expect(library.save(parseText("4 Lightning Bolt"), { name: "Dry", dryRun: true })).toMatchObject({ saved: false, id: "constructed/Dry" });
    expect(() => library.save(parseText("4 Lightning Bolt"))).toThrow(/no name/);
    expect(() => library.save(parseText("4 Lightning Bolt"), { name: "X", folder: "precons" })).toThrow(/cannot be saved/);
  });

  it("saves a cube with its draft definition, and a commander deck in the commander folder", () => {
    const dirs = forgeHome();
    const library = new DeckLibrary(dirs);
    const cube = library.save({ ...parseText("Lightning Bolt\nSol Ring"), format: "cube" }, { name: "Tiny Cube" });
    expect(cube).toMatchObject({ saved: true, id: "cube/Tiny Cube" });
    expect(readFileSync(join(dirs.res!, "draft", "Tiny Cube.draft"), "utf8")).toContain("DeckFile:Tiny Cube");
    const commander = library.save(parseText("1 Sol Ring\n98 Island\n\n1 Atraxa, Praetors' Voice"), { name: "Atraxa Two", subfolder: "ignored/../x" });
    expect(commander).toMatchObject({ saved: true, folder: "commander", commander: ["Atraxa, Praetors' Voice"], colors: "WUBG" });
    expect(commander.path.startsWith(join(dirs.decks, "commander"))).toBe(true);
  });
});

describe("deck sites", () => {
  /** Answers each URL from a recorded response and records what was asked for. */
  const recorded = (responses: Record<string, string>) => {
    const asked: string[] = [];
    const get: FetchText = async (url) => {
      asked.push(url);
      const hit = Object.entries(responses).find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return fixture(hit[1]);
    };
    return { get, asked };
  };

  it("reads a Moxfield deck from its API", async () => {
    const { get, asked } = recorded({ "https://api2.moxfield.com/v3/decks/all/abc_123-x": "moxfield.json" });
    const deck = await fetchDeck("https://moxfield.com/decks/abc_123-x", get);
    expect(asked).toEqual(["https://api2.moxfield.com/v3/decks/all/abc_123-x"]);
    expect(deck).toMatchObject({ site: "Moxfield", name: "Sample Modern Deck", format: "modern" });
    expect(countCards(deck.sections.Main)).toBe(60);
    expect(countCards(deck.sections.Sideboard)).toBe(15);
    expect(deck.meta).toContainEqual(["Source URL", "https://moxfield.com/decks/abc_123-x"]);
  });

  it("reads an Archidekt deck and puts the Commander category in the command zone", async () => {
    const { get } = recorded({ "https://archidekt.com/api/decks/7031486/": "archidekt.json" });
    const deck = await fetchDeck("https://www.archidekt.com/decks/7031486/some_name", get);
    expect(deck.format).toBe("commander");
    expect(countCards(deck.sections.Commander)).toBe(1);
    expect(countCards(deck.sections.Main)).toBe(99);
    expect(deck.sections.Main!.some((e) => e.set)).toBe(true);
  });

  it("reads an AetherHub deck and names it from the URL", async () => {
    const { get } = recorded({ "https://aetherhub.com/Deck/FetchMtgaDeckJson?deckId=1434102": "aetherhub.json" });
    const deck = await fetchDeck("https://aetherhub.com/Deck/abzan-midrange-1434102", get);
    expect(deck.name).toBe("Abzan Midrange");
    expect(countCards(deck.sections.Main)).toBe(60);
    expect(deck.sections.Main![0]).toMatchObject({ count: 3, name: "Plains", set: "HOP" });
  });

  it("reads an EDHREC average deck from a commander or average-deck URL", async () => {
    const { get, asked } = recorded({ "https://json.edhrec.com/pages/average-decks/atraxa-praetors-voice.json": "edhrec.json" });
    const deck = await fetchDeck("https://edhrec.com/commanders/atraxa-praetors-voice", get);
    expect(asked).toHaveLength(1);
    expect(deck.format).toBe("commander");
    expect(names(deck.sections.Commander)).toEqual(["1 Atraxa, Praetors' Voice"]);
    expect(countCards(deck.sections.Main)).toBe(99);
  });

  it("reads an MTGTop8 deck and its title", async () => {
    const { get } = recorded({ "https://mtgtop8.com/mtgo?d=911751": "mtgtop8.txt", "https://mtgtop8.com/event?": "mtgtop8.html" });
    const deck = await fetchDeck("https://mtgtop8.com/event?e=93717&d=911751&f=MO", get);
    expect(deck.name).toBe("Rakdos Delirium - Player");
    expect(countCards(deck.sections.Main)).toBe(60);
    expect(countCards(deck.sections.Sideboard)).toBe(15);
  });

  it("reads an MTGDecks page", async () => {
    const { get } = recorded({ "https://mtgdecks.net/Modern/boros-energy-decklist-by-player-1": "mtgdecks.html" });
    const deck = await fetchDeck("https://mtgdecks.net/Modern/boros-energy-decklist-by-player-1", get);
    expect(deck).toMatchObject({ name: "Modern Boros Energy deck by Player", format: "modern" });
    expect(countCards(deck.sections.Main)).toBe(60);
    expect(countCards(deck.sections.Sideboard)).toBeGreaterThan(0);
  });

  it("reads a Cube Cobra cube as a cube", async () => {
    const { get, asked } = recorded({ "https://cubecobra.com/cube/download/forge/modovintage": "cubecobra.dck" });
    const deck = await fetchDeck("https://cubecobra.com/cube/overview/modovintage", get);
    expect(asked).toEqual(["https://cubecobra.com/cube/download/forge/modovintage"]);
    expect(deck).toMatchObject({ name: "MTGO Vintage Cube", format: "cube" });
    expect(deck.sections.Main![0]).toMatchObject({ count: 1, name: "Giver of Runes", suffix: "|PRM" });
    expect(folderFor(deck)).toBe("cube");
  });

  it("says what to do for a site that cannot be fetched and for an unknown site", async () => {
    const never: FetchText = async () => {
      throw new Error("should not fetch");
    };
    await expect(fetchDeck("https://www.mtggoldfish.com/deck/8006030", never)).rejects.toThrow(/MTGGoldfish.*text export/);
    await expect(fetchDeck("https://tappedout.net/mtg-decks/burn/", never)).rejects.toThrow(/TappedOut/);
    await expect(fetchDeck("https://example.com/deck/1", never)).rejects.toThrow(/not a supported deck site/);
    await expect(fetchDeck("https://moxfield.com/users/someone", never)).rejects.toThrow(/Not a Moxfield deck URL/);
    await expect(fetchText("https://example.com/")).rejects.toThrow(/Refusing to fetch/);
    await expect(fetchText("http://moxfield.com/decks/x")).rejects.toThrow(/Refusing to fetch/);
  });
});

describe("deck tools", () => {
  it("lists decks, reads one, saves one and sends a deck id to the lobby as deck text", async () => {
    const { bridge, calls } = fakeBridge({ "POST /lobby/deck": { deck: "Bolt Precon", size: 24 } });
    const client = await connect(bridge);

    const list = await client.callTool({ name: "forge_decks", arguments: { query: "bolt" } });
    expect(list.isError).toBeFalsy();
    expect((list.structuredContent as { decks: { id: string }[] }).decks.map((d) => d.id)).toEqual(["precons/Bolt Precon"]);

    const one = await client.callTool({ name: "forge_decks", arguments: { id: "commander/Atraxa Vault" } });
    expect((one.structuredContent as { deck: { commander: string[]; path?: string } }).deck.commander).toEqual(["Atraxa, Praetors' Voice"]);
    expect((one.structuredContent as { deck: { path?: string } }).deck.path).toBeUndefined();

    const saved = await client.callTool({ name: "forge_deck_save", arguments: { text: "4 Lightning Bolt\n20 Mountain", name: "Burn" } });
    expect(saved.structuredContent).toMatchObject({ saved: true, id: "constructed/Burn", source: "text", colors: "R" });

    const both = await client.callTool({ name: "forge_deck_save", arguments: { text: "4 Lightning Bolt", url: "https://moxfield.com/decks/x" } });
    expect(both.isError).toBe(true);

    const lobby = await client.callTool({ name: "forge_lobby_deck", arguments: { id: "constructed/Burn" } });
    expect(lobby.isError).toBeFalsy();
    expect(calls.find((c) => c.path === "/lobby/deck")?.body).toEqual({ dck: "[metadata]\nName=Burn\n[Main]\n4 Lightning Bolt\n20 Mountain\n" });

    const missing = await client.callTool({ name: "forge_lobby_deck", arguments: { id: "constructed/Nope" } });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});
