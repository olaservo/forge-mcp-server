import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryServerEventBus, createMcpHandler } from "@modelcontextprotocol/server";
import { PNG } from "pngjs";
import { Bridge } from "../src/bridge.js";
import { DeckLibrary, type ForgeDirs } from "../src/decks/library.js";
import type { EventLog } from "../src/events.js";
import { createServer, skillCatalog } from "../src/server.js";
import type { WebhookHub } from "../src/webhooks.js";

/** A fake Forge bridge: records calls and answers with canned JSON keyed by `METHOD /path`. */
export function fakeBridge(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = responses[key];
    if (hit === undefined) {
      return new Response(JSON.stringify({ error: `unknown route ${key}` }), { status: 400 });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bridge: new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl }), calls };
}

const CARD_SCRIPTS: Record<string, string> = {
  "l/lightning_bolt.txt": "Name:Lightning Bolt\nManaCost:R\nTypes:Instant\nOracle:Lightning Bolt deals 3 damage to any target.",
  "m/mountain.txt": "Name:Mountain\nManaCost:no cost\nTypes:Basic Land Mountain",
  "i/island.txt": "Name:Island\nManaCost:no cost\nTypes:Basic Land Island",
  "a/ancient_tomb.txt": "Name:Ancient Tomb\nManaCost:no cost\nTypes:Land",
  "s/sol_ring.txt": "Name:Sol Ring\nManaCost:1\nTypes:Artifact",
  "d/delver_of_secrets_insectile_aberration.txt":
    "Name:Delver of Secrets\nManaCost:U\nTypes:Creature Human Wizard\nPT:1/1\nAlternateMode:DoubleFaced\n\nALTERNATE\n\nName:Insectile Aberration\nManaCost:no cost\nColors:blue\nTypes:Creature Human Insect\nPT:3/2",
  "f/fire_ice.txt": "Name:Fire\nManaCost:1 R\nTypes:Instant\nAlternateMode:Split\n\nALTERNATE\n\nName:Ice\nManaCost:1 U\nTypes:Instant",
  "b/bonecrusher_giant_stomp.txt":
    "Name:Bonecrusher Giant\nManaCost:2 R\nTypes:Creature Giant\nPT:4/3\nAlternateMode:Adventure\n\nALTERNATE\n\nName:Stomp\nManaCost:1 R\nTypes:Instant Adventure",
  "l/lim_duls_vault.txt": "Name:Lim-Dûl's Vault\nManaCost:U B\nTypes:Instant",
  "a/atraxa_praetors_voice.txt": "Name:Atraxa, Praetors' Voice\nManaCost:G W U B\nTypes:Legendary Creature Phyrexian Angel Horror\nPT:4/4",
};

/**
 * A small Forge install and user deck folder in a temp directory: ten card scripts, two editions,
 * one deck in constructed, one in commander and one precon.
 */
export function forgeHome(): ForgeDirs {
  const root = mkdtempSync(join(tmpdir(), "forge-home-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, script] of Object.entries(CARD_SCRIPTS)) put(`res/cardsfolder/${path}`, script);
  put("res/editions/Magic 2010.txt", "[metadata]\nCode=M10\nScryfallCode=M10\nName=Magic 2010\n\n[cards]\n146 C Lightning Bolt @Christopher Moeller\n");
  put(
    "res/editions/Tales of Middle-earth Commander.txt",
    '[metadata]\nCode=LTC\nCode2=LTC2\nScryfallCode=LTC\nName=Tales of Middle-earth Commander\n\n[cards]\n357 M Ancient Tomb @Anastasia Balakchina ${"flavorName": "Balin\'s Tomb"}\n',
  );
  put("res/quest/precons/Bolt Precon.dck", "[shop]\nCredits=1200\n[metadata]\nName=Bolt Precon\nDescription=Burn\nDeck Type=constructed\n[Main]\n20 Mountain|M10\n4 Lightning Bolt|M10\n");
  mkdirSync(join(root, "res/cube"), { recursive: true });
  mkdirSync(join(root, "res/draft"), { recursive: true });
  put("user/decks/constructed/Izzet Tempo.dck", "[metadata]\nName=Izzet Tempo\n[Main]\n4 Delver of Secrets|ISD|1\n4 Lightning Bolt\n4 Fire // Ice\n10 Island\n10 Mountain\n[Sideboard]\n2 Bonecrusher Giant\n");
  put("user/decks/commander/Atraxa Vault.dck", "[metadata]\nName=Atraxa Vault\n[Commander]\n1 Atraxa, Praetors' Voice\n[Main]\n1 Sol Ring\n1 Lim-Dûl's Vault\n30 Island\n");
  return { res: join(root, "res"), decks: join(root, "user/decks"), customCards: join(root, "user/custom/cards") };
}

/** An in-process MCP client over the Streamable HTTP handler, with no sockets. */
export async function connect(
  bridge: Bridge,
  bus?: InMemoryServerEventBus,
  events?: EventLog,
  webhooks?: { hub: WebhookHub; principal?: string },
  decks: DeckLibrary = new DeckLibrary(forgeHome()),
) {
  const skills = await skillCatalog();
  const factory = (ctx: { authInfo?: { clientId: string } }) =>
    createServer({ bridge, skills, events, webhooks: webhooks?.hub, principal: ctx.authInfo?.clientId, decks });
  const handler = createMcpHandler(factory, bus ? { bus } : {});
  const authInfo = webhooks?.principal ? { token: "test", clientId: webhooks.principal, scopes: [] } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return client;
}

/** Writes an opaque avatar sheet of `columns` x `rows` 100 px tiles, with the tiles in `empty` left transparent. Returns its path. */
export function avatarSheet(columns: number, rows: number, empty: [number, number][] = []): string {
  const png = new PNG({ width: columns * 100, height: rows * 100 });
  for (let i = 0; i < png.data.length; i += 4) {
    const x = Math.floor(((i / 4) % png.width) / 100);
    const y = Math.floor(i / 4 / png.width / 100);
    const isEmpty = empty.some(([ex, ey]) => ex === x && ey === y);
    png.data.set([40 * x, 60 * y, 120, isEmpty ? 0 : 255], i);
  }
  const path = join(mkdtempSync(join(tmpdir(), "forge-avatars-")), "sprite_avatars.png");
  writeFileSync(path, PNG.sync.write(png));
  return path;
}
