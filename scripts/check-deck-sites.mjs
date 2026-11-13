#!/usr/bin/env node
// Fetches one deck from each supported deck site and checks it against the cards Forge implements.
// Run `npm run build` first. FORGE_HOME must point at a Forge install.
//
//   node scripts/check-deck-sites.mjs                 the sample decks below
//   node scripts/check-deck-sites.mjs <url> ...       your own
//   node scripts/check-deck-sites.mjs --out <dir>     also writes each converted deck as .dck into <dir>
//
// The samples are public decks that existed on 2026-11-13. Replace one when its site drops it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toDck } from "../dist/decks/decklist.js";
import { DeckLibrary, fileName, forgeDirs } from "../dist/decks/library.js";
import { fetchDeck, SITES } from "../dist/decks/sites.js";

const SAMPLES = [
  "https://moxfield.com/decks/YB8wVesOBEaCs_trx9ZGiw",
  "https://archidekt.com/decks/7031486",
  "https://aetherhub.com/Deck/abzan-1434102",
  "https://edhrec.com/average-decks/atraxa-praetors-voice",
  "https://mtgtop8.com/event?e=93717&d=911751&f=MO",
  "https://mtgdecks.net/Modern/boros-energy-decklist-by-forcato-3173421",
  "https://cubecobra.com/cube/overview/modovintage",
];

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt < 0 ? undefined : args.splice(outAt, 2)[1];
const urls = args.length > 0 ? args : SAMPLES;

if (!process.env.FORGE_HOME) {
  console.error("Set FORGE_HOME to a Forge install folder.");
  process.exit(2);
}
const library = new DeckLibrary(forgeDirs());
if (!library.cards()) {
  console.error(`No card scripts under ${process.env.FORGE_HOME}/res/cardsfolder.`);
  process.exit(2);
}
if (out) mkdirSync(out, { recursive: true });

let failed = 0;
for (const url of urls) {
  try {
    const fetched = await fetchDeck(url);
    const result = library.save(fetched, { dryRun: true });
    const ok = result.unknown.length === 0;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${fetched.site.padEnd(11)} ${result.folder.padEnd(12)} main ${String(result.main).padStart(3)} side ${String(result.sideboard).padStart(2)}` +
        ` cmdr ${result.commander.length} colors ${result.colors || "-"}  ${result.name}`,
    );
    if (!ok) console.log(`     unknown: ${result.unknown.join("; ")}`);
    if (out) writeFileSync(join(out, `${fileName(`${fetched.site} - ${result.name}`)}.dck`), toDck(library.resolve(fetched).deck));
  } catch (e) {
    failed++;
    console.log(`FAIL ${new URL(url).hostname}  ${e instanceof Error ? e.message : e}`);
  }
}
for (const site of SITES.filter((s) => !s.fetch)) console.log(`text ${site.name}: no fetch, pass the deck's text export`);
process.exit(failed ? 1 : 0);
