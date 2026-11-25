// Drafts one seat through a real draft with a fixed policy and no model, using only what a seat woken by events has:
// the forge.your_move events and the answers to its own picks. It checks the wiring between this server and the bridge:
// the pack in the draft_pick event, the next pack in a pick's answer, rules text once per card name, the counts of the
// picks, `at` and a stale pick, the pool, and the deck built from it.
//   node scripts/smoke-draft.mjs <host port> <server url> [seat name] [slow pick]
// With a pick clock on the host, `slow pick` is the pick the seat sits on until the clock has run out: the host then
// picks for it, and the seat's own pick, which names the pack it saw, has to come back stale.
// Start a host with a draft set up first (DraftHost in forge-agent-bridge's test sources) and the server over HTTP
// with FORGE_JAR, FORGE_HOME and FORGE_BRIDGE_JAR.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const [hostPort, url, seatName = "SmokeDrafter", slowPickArg] = process.argv.slice(2);
const slowPick = Number(slowPickArg ?? 0);
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));
/** The pick at which a pick naming an earlier pack is sent. */
const STALE_AT_PICK = 5;

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  return ok;
};

const withHeaders = (target, init) => {
  const headers = new globalThis.Headers(init?.headers);
  if (String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", "forge.your_move");
  return fetch(target, { ...init, headers });
};
const client = new Client({ name: "smoke-draft", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: withHeaders }));

const counts = {};
const call = async (tool, args = {}) => {
  counts[tool] = (counts[tool] ?? 0) + 1;
  const res = await client.callTool({ name: tool, arguments: args }, { timeout: 180_000 });
  if (res.isError) throw new Error(`${tool} ${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
  return res.structuredContent;
};

let cursor = null;
const eventKinds = {};
/** The next forge.your_move events, oldest first. The first poll returns the ask pending now. */
async function poll() {
  const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor } }, z.looseObject({}));
  cursor = res.cursor;
  for (const e of res.events ?? []) eventKinds[e.data.kind] = (eventKinds[e.data.kind] ?? 0) + 1;
  return (res.events ?? []).map((e) => e.data);
}
/** Waits for an event that `wanted` accepts. */
async function nextEvent(wanted, seconds = 120) {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(200)) {
    const hit = (await poll()).find(wanted);
    if (hit) return hit;
  }
  throw new Error("no event arrived in time");
}

await call("forge_status");
await call("forge_connect", { host: "127.0.0.1", port: Number(hostPort), name: seatName });
const lobbyEvent = await nextEvent((e) => e.kind === "lobby", 20);
console.log(`lobby event: ${lobbyEvent.prompt}`);
await call("forge_lobby_ready", { ready: true });

const picks = [];
const picked = new Set();
const textSeen = new Set();
const cardTypes = new Map();
const from = { event: 0, answer: 0 };
let textRepeats = 0;
let textNames = 0;
let chars = 0;
let staleDone = false;
let pool;

/** Reads a pack view the seat was given, from an event or a pick's answer. */
function read(view, source) {
  from[source]++;
  chars += JSON.stringify(view).length;
  check(typeof view.at === "string" && view.at === `${view.packNumber}:${view.pickNumber}`, `pack ${view.at} names itself`);
  check(Array.isArray(view.pack) && view.pack.length === 16 - view.pickNumber, `pack ${view.at} has ${16 - view.pickNumber} cards`);
  for (const card of view.pack ?? []) cardTypes.set(card.name, String(card.type ?? ""));
  for (const name of Object.keys(view.cardText ?? {})) {
    textNames++;
    if (textSeen.has(name)) {
      textRepeats++;
      console.log(`      text sent again: ${name} in ${view.at} from the ${source}`);
    }
    textSeen.add(name);
  }
  checkDrafted(view, view.at);
}

function checkDrafted(view, where) {
  if (picks.length === 0) return check(view.drafted === undefined, `no counts before the first pick at ${where}`);
  const d = view.drafted ?? {};
  const types = picks.map((name) => cardTypes.get(name) ?? "");
  const lands = types.filter((t) => /\bLand\b/.test(t)).length;
  const creatures = types.filter((t) => /\bCreature\b/.test(t) && !/\bLand\b/.test(t)).length;
  const curve = Object.values(d.curve ?? {}).reduce((a, b) => a + b, 0);
  const ok = d.count === picks.length && (d.lands ?? 0) === lands && d.creatures === creatures && d.other === picks.length - lands - creatures && curve === picks.length - lands && !d.unknown;
  return check(ok, `drafted at ${where} matches ${picks.length} picks: ${JSON.stringify(d)}`);
}

let view;
for (;;) {
  if (!view) {
    const event = await nextEvent((e) => e.kind === "deck" || (e.kind === "draft_pick" && !picked.has(e.at)));
    if (event.kind === "deck") {
      pool = event.pool;
      console.log(`deck event: pool of ${pool?.size}`);
      break;
    }
    if (!check(Array.isArray(event.pack), `the draft_pick event for ${event.prompt} carries the pack`)) throw new Error(`event without a pack: ${JSON.stringify(event).slice(0, 300)}`);
    view = event;
    read(view, "event");
  }
  if (!staleDone && picks.length === STALE_AT_PICK - 1) {
    staleDone = true;
    const stale = await call("forge_draft_pick", { card: "0", at: "1:1" });
    const status = await call("forge_status");
    const sent = status.draft?.picks?.length !== picks.length || status.draft?.at !== view.at;
    console.log(`stale pick at ${view.at} naming 1:1 -> stale ${stale.stale}, picked ${JSON.stringify(stale.picked ?? null)}, at ${stale.at}, bridge picks ${status.draft?.picks?.length}, pack still ${status.draft?.at}`);
    check(stale.stale === true && stale.picked === undefined && stale.at === view.at && !sent, "the stale pick answers stale and sends nothing");
    check(Array.isArray(stale.pack) && stale.pack.length === view.pack.length, "the stale answer has the waiting pack");
  }
  const card = view.pack[0].name;
  if (picks.length === slowPick - 1 && typeof view.secondsLeft === "number") {
    console.log(`sitting on ${view.at} for ${view.secondsLeft + 2} s, clock at ${view.secondsLeft} s`);
    await sleep((view.secondsLeft + 2) * 1000);
    const late = await call("forge_draft_pick", { card, at: view.at });
    console.log(`late pick at ${view.at} -> stale ${late.stale}, picked ${JSON.stringify(late.picked ?? null)}, now ${late.at ?? (late.waiting ? "waiting" : "-")}, autoPicks ${JSON.stringify(late.autoPicks ?? [])}`);
    check(late.stale === true && late.picked === undefined && late.at !== view.at, "a pick after the clock ran out is stale and is not made from the next pack");
    check(late.autoPicks?.length === 1 && late.autoPicks[0].startsWith(card), "the answer names the card the host picked");
    // The host took the first card of the pack, which is the card this seat picks.
    picks.push(card);
    picked.add(view.at);
    view = late.pack ? late : undefined;
    if (view) read(view, "answer");
    continue;
  }
  const answer = await call("forge_draft_pick", { card, at: view.at });
  check(answer.picked?.name === card && answer.stale !== true && answer.weakCheck !== true, `pick ${view.at} ${card} is confirmed and checked by the bridge`);
  picks.push(card);
  picked.add(view.at);
  const next = answer.pack ? "next pack" : answer.poolReceived ? (answer.pool ? "pool" : "pool to come") : "waiting";
  if (picks.length <= 3 || picks.length % 15 === 0 || next !== "next pack") console.log(`pick ${picks.length} at ${view.at}: ${card} -> ${next}${answer.pack ? ` ${answer.at}` : ""}`);
  if (answer.pack) {
    view = answer;
    read(view, "answer");
    continue;
  }
  checkDrafted(answer, `the answer to ${view.at}`);
  check(answer.waiting === true || answer.poolReceived === true, `the answer to ${view.at} says what the seat waits for`);
  if (answer.pool) {
    pool = answer.pool;
    break;
  }
  view = undefined;
}

console.log(`packs: ${from.event} from events, ${from.answer} from pick answers, ${chars} characters in all. cardText: ${textNames} names sent, ${textRepeats} repeated`);
check(from.event + from.answer === picks.length && picks.length === 45, `45 packs arrived in an event or a pick answer (${from.event} + ${from.answer})`);
check(counts.forge_draft_pack === undefined, "forge_draft_pack was never called");
check(textRepeats === 0, "cardText never repeats a card name");

const names = (pool?.cards ?? []).flatMap((c) => Array.from({ length: c.count }, () => c.name));
console.log(`pool: size ${pool?.size}, ${pool?.cards?.length} names, counts ${JSON.stringify(pool?.counts)}, new text for ${Object.keys(pool?.cardText ?? {}).length} names`);
check(pool?.size === 45 && names.length === 45 && pool.counts?.count === 45, "the pool arrives with 45 cards");
check([...picks].sort().join("|") === [...names].sort().join("|"), "the pool is the cards picked");
check(Object.keys(pool?.cardText ?? {}).every((name) => !textSeen.has(name)), "the pool repeats no text");
check(counts.forge_draft_pool === undefined, "forge_draft_pool was never called");

const spells = (pool?.cards ?? []).filter((c) => !/\bLand\b/.test(String(c.type))).flatMap((c) => Array.from({ length: c.count }, () => c.name));
const deck = await call("forge_draft_deck", { main: spells.slice(0, 23), lands: { Plains: 17 } });
console.log(`deck: size ${deck.size}, lands ${deck.lands}, problem ${deck.problem}, ready ${deck.ready}, ${deck.cards?.length} card rows, ${deck.cards?.filter((c) => c.text).length} with text, counts ${JSON.stringify(deck.counts)}`);
check(deck.size === 40 && deck.lands === 17 && deck.problem === null, "the deck of 23 pool cards and 17 basic lands is legal");
check(deck.ready === true, "the seat is still ready from before the draft");
check(deck.counts?.count === 23 && deck.cards?.reduce((n, c) => n + c.count, 0) === 23, "the deck answer describes the 23 pool cards");

// The host starts the match when it has one to start. Not a failure when it does not.
const game = await nextEvent((e) => e.kind === "decision" || e.kind === "priority", 30).catch(() => undefined);
if (game) console.log(`first game event: ${game.kind} "${String(game.prompt).slice(0, 60)}" {${Object.keys(game).join(" ")}}, cardText for ${Object.keys(game.cardText ?? {}).length} names, hand of ${game.hand?.length}`);
else console.log("no game event within 30 s");
if (game) check(Object.keys(game.cardText ?? {}).every((name) => !spells.slice(0, 23).includes(name)), "the first game event sends no text for the deck's cards");

await call("forge_disconnect");
console.log(`events: ${JSON.stringify(eventKinds)}`);
console.log(`calls: ${JSON.stringify(counts)}`);
await client.close();
for (const what of failures) console.log(`FAILED: ${what}`);
console.log(failures.length ? `${failures.length} check(s) failed` : "all checks passed");
process.exit(failures.length ? 1 : 0);
