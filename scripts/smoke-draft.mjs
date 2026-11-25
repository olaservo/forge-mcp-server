// Drafts one or two seats through a real draft or sealed event with a fixed policy and no model, each seat using only
// what a seat woken by events has: the forge.your_move events and the answers to its own picks. It checks the wiring
// between this server and the bridge: the pack in the draft_pick event, the next pack in a pick's answer, rules text
// once per card name, the counts of the picks, `at` and a stale pick, the pool, the deck built from it, and the first
// turns of the match that follows.
//   node scripts/smoke-draft.mjs <host port> <server url> [second server url] [options]
//     --slow N        seat N (0 or 1) waits 3 seconds before some picks of the first round, so packs queue behind it
//     --clock-out P   the slow seat, or seat 0, sits on its pick P until the host's pick clock has run out
//     --sealed        the host runs a sealed event: no picks, the pool arrives at once
//     --turns T       after the decks, play until turn T with the policy of smoke-two-seats.mjs. Default 0
// Start a host first (DraftHost in forge-agent-bridge's test sources) and each server over HTTP with FORGE_JAR,
// FORGE_HOME and FORGE_BRIDGE_JAR, so that each has a bridge of its own.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sealed") options.sealed = true;
  else if (args[i].startsWith("--")) options[args[i].slice(2)] = Number(args[++i]);
  else positional.push(args[i]);
}
const [hostPort, ...urls] = positional;
const slowSeat = options.slow ?? -1;
const clockOutPick = options["clock-out"] ?? 0;
const lastTurn = options.turns ?? 0;
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));
/** The pick at which seat 0 sends a pick naming an earlier pack. */
const STALE_AT_PICK = 5;
/** How long forge_draft_pick holds its answer for the next pack. */
const HOLD_MS = 2000;

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  return ok;
};
const isLand = (type) => /\bLand\b/.test(String(type ?? ""));

async function seat(index, url) {
  const name = urls.length > 1 ? `Smoke${"AB"[index]}` : "SmokeDrafter";
  const withHeaders = (target, init) => {
    const headers = new globalThis.Headers(init?.headers);
    if (String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", "forge.your_move");
    return fetch(target, { ...init, headers });
  };
  const client = new Client({ name: "smoke-draft", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: withHeaders }));
  const s = {
    index,
    name,
    counts: {},
    eventKinds: {},
    /** How many draft_pick events named each pack. */
    eventAts: new Map(),
    picks: [],
    picked: new Set(),
    seen: [],
    textSeen: new Set(),
    cardTypes: new Map(),
    from: { event: 0, answer: 0 },
    textNames: 0,
    textRepeats: 0,
    chars: 0,
    waits: 0,
    queuedSeen: 0,
    queuedWrong: 0,
    autoPicked: [],
    landTurn: -1,
    tried: new Set(),
    close: () => client.close(),
  };
  s.call = async (tool, toolArgs = {}) => {
    s.counts[tool] = (s.counts[tool] ?? 0) + 1;
    const res = await client.callTool({ name: tool, arguments: toolArgs }, { timeout: 180_000 });
    if (res.isError) throw new Error(`${name} ${tool} ${JSON.stringify(toolArgs)}: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  };
  let cursor = null;
  /** The next forge.your_move events, oldest first. The first poll returns the ask pending now. */
  s.poll = async () => {
    const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor } }, z.looseObject({}));
    cursor = res.cursor;
    for (const e of res.events ?? []) {
      s.eventKinds[e.data.kind] = (s.eventKinds[e.data.kind] ?? 0) + 1;
      if (e.data.kind === "draft_pick" && e.data.at) s.eventAts.set(e.data.at, (s.eventAts.get(e.data.at) ?? 0) + 1);
    }
    return (res.events ?? []).map((e) => e.data);
  };
  /** Waits for an event that `wanted` accepts. */
  s.nextEvent = async (wanted, seconds = 180) => {
    for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(200)) {
      const hit = (await s.poll()).find(wanted);
      if (hit) return hit;
    }
    throw new Error(`${name}: no event arrived in time`);
  };
  /** The ask pending now, as a client that starts following is given it. */
  s.pending = async () => {
    const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor: null } }, z.looseObject({}));
    return res.events?.at(-1)?.data;
  };
  return s;
}

function checkDrafted(s, view, where) {
  if (s.picks.length === 0) return check(view.drafted === undefined, `${s.name}: no counts before the first pick at ${where}`);
  const d = view.drafted ?? {};
  const types = s.picks.map((name) => s.cardTypes.get(name) ?? "");
  const lands = types.filter(isLand).length;
  const creatures = types.filter((t) => /\bCreature\b/.test(t) && !isLand(t)).length;
  const curve = Object.values(d.curve ?? {}).reduce((a, b) => a + b, 0);
  const ok = d.count === s.picks.length && (d.lands ?? 0) === lands && d.creatures === creatures && d.other === s.picks.length - lands - creatures && curve === s.picks.length - lands && !d.unknown;
  check(JSON.stringify(view.autoPicks ?? []) === JSON.stringify(s.autoPicked), `${s.name}: autoPicks at ${where} are ${JSON.stringify(s.autoPicked)}, got ${JSON.stringify(view.autoPicks ?? [])}`);
  return check(ok, `${s.name}: drafted at ${where} matches ${s.picks.length} picks: ${JSON.stringify(d)}`);
}

/** Reads a pack view the seat was given, from an event or a pick's answer. */
function read(s, view, source) {
  s.from[source]++;
  s.chars += JSON.stringify(view).length;
  s.seen.push(view.at);
  check(typeof view.at === "string" && view.at === `${view.packNumber}:${view.pickNumber}`, `${s.name}: pack ${view.at} names itself`);
  check(Array.isArray(view.pack) && view.pack.length === 16 - view.pickNumber, `${s.name}: pack ${view.at} has ${16 - view.pickNumber} cards`);
  for (const card of view.pack ?? []) s.cardTypes.set(card.name, String(card.type ?? ""));
  for (const name of Object.keys(view.cardText ?? {})) {
    s.textNames++;
    if (s.textSeen.has(name)) {
      s.textRepeats++;
      console.log(`      ${s.name}: text sent again: ${name} in ${view.at} from the ${source}`);
    }
    s.textSeen.add(name);
  }
  if (view.queued) s.queuedSeen++;
  checkDrafted(s, view, view.at);
}

/** Every pick of the draft. Returns the pool. */
async function draft(s) {
  let view;
  let staleDone = s.index !== 0;
  const sitsOut = clockOutPick > 0 && s.index === Math.max(slowSeat, 0);
  for (;;) {
    if (!view) {
      const event = await s.nextEvent((e) => e.kind === "deck" || (e.kind === "draft_pick" && !s.picked.has(e.at)));
      if (event.kind === "deck") {
        console.log(`${s.name} deck event: pool of ${event.pool?.size}`);
        return event.pool;
      }
      if (!check(Array.isArray(event.pack), `${s.name}: the draft_pick event for ${event.prompt} carries the pack`)) throw new Error(`event without a pack: ${JSON.stringify(event).slice(0, 300)}`);
      view = event;
      read(s, view, "event");
    }
    const card = view.pack[0].name;
    const queued = view.queued ?? 0;
    if (!staleDone && s.picks.length === STALE_AT_PICK - 1) {
      staleDone = true;
      const stale = await s.call("forge_draft_pick", { card: "0", at: "1:1" });
      const status = await s.call("forge_status");
      const sent = status.draft?.picks?.length !== s.picks.length || status.draft?.at !== view.at;
      console.log(`${s.name} stale pick at ${view.at} naming 1:1 -> stale ${stale.stale}, picked ${JSON.stringify(stale.picked ?? null)}, at ${stale.at}, bridge picks ${status.draft?.picks?.length}, pack still ${status.draft?.at}`);
      check(stale.stale === true && stale.picked === undefined && stale.at === view.at && !sent, `${s.name}: the stale pick answers stale and sends nothing`);
      check(Array.isArray(stale.pack) && stale.pack.length === view.pack.length, `${s.name}: the stale answer has the waiting pack`);
      const unnamed = await s.call("forge_draft_pick", { card: "0" });
      const after = await s.call("forge_status");
      console.log(`${s.name} pick at ${view.at} naming no pack -> stale ${unnamed.stale}, picked ${JSON.stringify(unnamed.picked ?? null)}, at ${unnamed.at}, bridge picks ${after.draft?.picks?.length}, "${unnamed.problem}"`);
      check(unnamed.stale === true && unnamed.picked === undefined && unnamed.at === view.at && typeof unnamed.problem === "string" && after.draft?.picks?.length === s.picks.length && after.draft?.at === view.at, `${s.name}: a pick that names no pack sends nothing and answers with the waiting pack`);
    }
    if (sitsOut && s.picks.length === clockOutPick - 1 && typeof view.secondsLeft === "number") {
      console.log(`${s.name} sitting on ${view.at} for ${view.secondsLeft + 2} s, clock at ${view.secondsLeft} s, queued ${queued}`);
      await sleep((view.secondsLeft + 2) * 1000);
      const late = await s.call("forge_draft_pick", { card, at: view.at });
      console.log(`${s.name} late pick at ${view.at} -> stale ${late.stale}, picked ${JSON.stringify(late.picked ?? null)}, now ${late.at ?? (late.waiting ? "waiting" : "-")}, autoPicks ${JSON.stringify(late.autoPicks ?? [])}`);
      check(late.stale === true && late.picked === undefined && late.at !== view.at, `${s.name}: a pick after the clock ran out is stale and is not made from the next pack`);
      // The host takes the first card of the pack, which is the card this seat picks.
      s.autoPicked.push(`${card} (pack ${view.packNumber} pick ${view.pickNumber})`);
      s.picks.push(card);
      s.picked.add(view.at);
      view = late.pack ? late : undefined;
      if (view) read(s, view, "answer");
      else checkDrafted(s, late, "the late pick");
      continue;
    }
    if (s.index === slowSeat && view.packNumber === 1 && view.pickNumber % 3 === 2) await sleep(3000);
    const started = Date.now();
    const answer = await s.call("forge_draft_pick", { card, at: view.at });
    const took = Date.now() - started;
    check(answer.picked?.name === card && answer.stale !== true && answer.weakCheck !== true, `${s.name}: pick ${view.at} ${card} is confirmed and checked by the bridge`);
    s.picks.push(card);
    s.picked.add(view.at);
    const next = answer.pack ? "next pack" : answer.poolReceived ? (answer.pool ? "pool" : "pool to come") : "waiting";
    if (s.picks.length <= 2 || s.picks.length % 15 === 0 || (next === "waiting" && s.waits < 3)) console.log(`${s.name} pick ${s.picks.length} at ${view.at}: ${card} -> ${next}${answer.pack ? ` ${answer.at}` : ""} in ${took} ms`);
    // A pack that was queued behind this one is there at once. The host sends its counts from the thread of each
    // pick, so two picks close together can deliver them out of order and leave the count a pack high.
    if (queued > 0 && !(Array.isArray(answer.pack) && took < HOLD_MS)) {
      s.queuedWrong++;
      console.log(`${s.name} at ${view.at}: queued ${queued}, and the answer had no next pack`);
    }
    if (answer.pack) {
      check(took < HOLD_MS + 1500, `${s.name}: the answer with the next pack came in ${took} ms`);
      view = answer;
      read(s, view, "answer");
      continue;
    }
    checkDrafted(s, answer, `the answer to ${view.at}`);
    check(answer.waiting === true || answer.poolReceived === true, `${s.name}: the answer to ${view.at} says what the seat waits for`);
    if (answer.waiting) {
      s.waits++;
      check(took >= HOLD_MS - 200, `${s.name}: the waiting answer to ${view.at} was held for ${took} ms`);
    }
    if (answer.pool) return answer.pool;
    view = undefined;
  }
}

/** The checks on a finished draft, and the deck. Returns the names of the deck's pool cards. */
async function build(s, pool) {
  const n = s.picks.length;
  if (!options.sealed) {
    const order = [1, 2, 3].flatMap((p) => Array.from({ length: 15 }, (_, k) => `${p}:${k + 1}`));
    console.log(`${s.name} packs: ${s.from.event} from events, ${s.from.answer} from pick answers, ${s.waits} waiting answers, ${s.queuedSeen} views with packs queued (${s.queuedWrong} not followed by a pack), ${s.chars} characters. cardText: ${s.textNames} names sent, ${s.textRepeats} repeated`);
    check(s.from.event + s.from.answer === 45 && n === 45, `${s.name}: 45 packs arrived in an event or a pick answer (${s.from.event} + ${s.from.answer})`);
    check(s.seen.join(" ") === order.join(" "), `${s.name}: the packs came in order, each once: ${s.seen.join(" ")}`);
    check([...s.eventAts.values()].every((count) => count === 1), `${s.name}: no pack was reported by two events: ${JSON.stringify([...s.eventAts].filter(([, c]) => c > 1))}`);
    check(s.counts.forge_draft_pack === undefined, `${s.name}: forge_draft_pack was never called`);
    check(s.textRepeats === 0, `${s.name}: cardText never repeats a card name`);
  }
  const names = (pool?.cards ?? []).flatMap((c) => Array.from({ length: c.count }, () => c.name));
  console.log(`${s.name} pool: size ${pool?.size}, ${pool?.cards?.length} names, counts ${JSON.stringify(pool?.counts)}, new text for ${Object.keys(pool?.cardText ?? {}).length} names`);
  check(pool?.size === names.length && pool.counts?.count === names.length && names.length >= 45, `${s.name}: the pool arrives with its cards counted (${names.length})`);
  if (options.sealed) {
    check(Object.keys(pool?.cardText ?? {}).length > 40, `${s.name}: a sealed pool comes with its rules text`);
  } else {
    check(names.length === 45 && [...s.picks].sort().join("|") === [...names].sort().join("|"), `${s.name}: the pool is the cards picked`);
    check(Object.keys(pool?.cardText ?? {}).every((name) => !s.textSeen.has(name)), `${s.name}: the pool repeats no text`);
  }
  check(s.counts.forge_draft_pool === undefined, `${s.name}: forge_draft_pool was never called`);

  if (!options.sealed) {
    // The script's own read: every card of the pool that has rules text was sent it during the draft.
    const all = await s.call("forge_draft_pool", { allText: true });
    const withheld = Object.keys(all.cardText ?? {}).filter((name) => !s.textSeen.has(name));
    console.log(`${s.name} text: ${Object.keys(all.cardText ?? {}).length} pool names have rules text, ${withheld.length} of them never sent ${JSON.stringify(withheld)}`);
    check(withheld.length === 0, `${s.name}: no pool card's text was withheld during the draft`);
  }
  const spells = (pool?.cards ?? []).filter((c) => !isLand(c.type)).flatMap((c) => Array.from({ length: c.count }, () => c.name));
  const main = spells.slice(0, 23);
  const deck = await s.call("forge_draft_deck", { main, lands: { Plains: 17 } });
  console.log(`${s.name} deck: size ${deck.size}, lands ${deck.lands}, sideboard ${deck.sideboardSize}, problem ${deck.problem}, ready ${deck.ready}, ${deck.cards?.length} card rows, ${deck.cards?.filter((c) => c.text).length} with text`);
  check(deck.size === 40 && deck.lands === 17 && deck.problem === null && deck.sideboardSize === names.length - 23, `${s.name}: the deck of 23 pool cards and 17 basic lands is legal`);
  check(deck.ready === true, `${s.name}: the seat is still ready from before the event`);
  check(deck.counts?.count === 23 && deck.cards?.reduce((sum, c) => sum + c.count, 0) === 23, `${s.name}: the deck answer describes the 23 pool cards`);
  return new Set(main);
}

function show(who, did, v) {
  const flags = ["waiting", "stale", "refused", "gameOver"].filter((k) => v[k]).join(",");
  const has = ["hand", "stack", "combat", "selection", "pendingDecision", "board", "cardText", "since"].filter((k) => v[k] !== undefined);
  console.log(`${who} ${did.padEnd(34)} -> #${v.promptCount} t${v.turn ?? "-"} ${v.phase ?? "-"} [${flags}] {${has.join(" ")}} ${String(v.prompt ?? "").replace(/\n/g, " / ").slice(0, 70)}`);
}

/** One action for the prompt in `v`, as smoke-two-seats.mjs chooses it. */
async function act(s, v) {
  const go = async (action) => {
    const out = await s.call("forge_game_act", { ...action, at: v.promptCount });
    show(s.name, JSON.stringify(action), out);
    return out;
  };
  const prompt = String(v.prompt ?? "");
  if (v.pendingDecision) {
    const out = await s.call("forge_game_decide", { id: v.pendingDecision.id, choices: [0] });
    show(s.name, `decide ${v.pendingDecision.kind} 0`, out);
    return out;
  }
  const hand = v.hand ?? [];
  if (prompt.startsWith("Priority") && v.activePlayer === s.name && String(v.phase).startsWith("MAIN") && !v.stack) {
    const land = hand.find((c) => isLand(c.type));
    if (land && s.landTurn !== v.turn) {
      s.landTurn = v.turn;
      return go({ action: "selectCard", id: land.id });
    }
    const playable = new Set((v.actionable ?? []).map((c) => c.id));
    const spell = hand.find((c) => !isLand(c.type) && playable.has(c.id) && !s.tried.has(`${v.turn}:${c.id}`));
    if (spell) {
      s.tried.add(`${v.turn}:${spell.id}`);
      return go({ action: "selectCard", id: spell.id, pay: "auto", pass: true });
    }
    return go({ action: "ok" });
  }
  if (/creatures to attack/.test(prompt)) {
    await go({ action: "alphaStrike" });
    const out = await s.call("forge_game_act", { action: "ok", endTurn: true });
    show(s.name, '{"action":"ok","endTurn":true}', out);
    return out;
  }
  if (v.selection && (v.selection.min ?? 0) > (v.selection.chosen?.length ?? 0)) {
    const player = (v.selection.players ?? []).find((p) => p.name !== s.name);
    if (player) return go({ action: "selectPlayer", id: player.id, pay: "auto", pass: true });
    const card = (v.selection.cards ?? [])[0];
    if (card) return go({ action: "selectCard", id: card.id, pay: "auto", pass: true });
  }
  if (v.buttons?.ok) return go({ action: "ok" });
  if (v.buttons?.cancel) return go({ action: "cancel" });
  return v;
}

/** Plays until `lastTurn` from the events, and checks the first game event each seat is given. */
async function play(seats, decks) {
  let turn = 0;
  const first = new Set();
  const dealt = new Set();
  const textSent = new Map(seats.map((s) => [s, new Set()]));
  for (let step = 0; step < 600 && turn < lastTurn; step++) {
    let moved = false;
    for (const s of seats) {
      const g = (await s.call("forge_status")).game;
      if (!g?.inGame || g.gameOver) continue;
      turn = Math.max(turn, g.turn ?? 0);
      if (g.waiting) continue;
      const event = await s.pending();
      if (!event || event.promptCount !== g.promptCount) continue;
      for (const name of Object.keys(event.cardText ?? {})) textSent.get(s).add(name);
      if (!first.has(s)) {
        first.add(s);
        console.log(`${s.name} first game event: ${event.kind} "${String(event.prompt).replace(/\n/g, " / ").slice(0, 60)}" {${Object.keys(event).join(" ")}}, cardText for ${Object.keys(event.cardText ?? {}).length} names`);
        check(typeof event.promptCount === "number" && event.life !== undefined, `${s.name}: the first game event is the game view`);
      }
      const out = await act(s, event);
      // The seat that won the toss is asked to play or draw before the hands are dealt.
      for (const v of [event, out]) {
        if (dealt.has(s) || !v.hand) continue;
        dealt.add(s);
        const own = v.hand.filter((c) => decks.get(s).has(c.name) || /^(Plains)$/.test(c.name)).length;
        console.log(`${s.name} opening hand: ${v.hand.length} cards, ${own} from its deck, in ${v === event ? "an event" : "an answer"} "${String(v.prompt).replace(/\n/g, " / ").slice(0, 50)}"`);
        check(v.hand.length === 7 && own === 7, `${s.name}: the opening hand is 7 cards of the deck it built`);
      }
      for (const name of Object.keys(out.cardText ?? {})) textSent.get(s).add(name);
      moved = true;
    }
    if (!moved) await sleep(300);
  }
  check(first.size === seats.length && dealt.size === seats.length && turn >= lastTurn, `the match reached turn ${lastTurn} with every seat asked and dealt a hand (turn ${turn}, ${first.size} seats)`);
  for (const s of seats) {
    const own = [...textSent.get(s)].filter((name) => decks.get(s).has(name));
    console.log(`${s.name} game: cardText for ${textSent.get(s).size} names, ${own.length} of them in its own deck ${JSON.stringify(own)}`);
    check(own.length === 0, `${s.name}: the game sends no text for the cards of its deck`);
  }
  show(seats[0].name, "concede", await seats[0].call("forge_game_act", { action: "concede" }));
  await sleep(3000);
  for (const s of seats) console.log(`${s.name} quit -> ${JSON.stringify(await s.call("forge_game_act", { action: "quit" })).slice(0, 120)}`);
}

const seats = await Promise.all(urls.map((url, i) => seat(i, url)));
for (const s of seats) {
  await s.call("forge_status");
  await s.call("forge_connect", { host: "127.0.0.1", port: Number(hostPort), name: s.name });
  const lobby = await s.nextEvent((e) => e.kind === "lobby", 20);
  console.log(`${s.name} lobby event: ${lobby.prompt}`);
}
for (const s of seats) await s.call("forge_lobby_ready", { ready: true });

const pools = await Promise.all(seats.map((s) => (options.sealed ? s.nextEvent((e) => e.kind === "deck").then((e) => e.pool) : draft(s))));
if (seats.length > 1 && !options.sealed) {
  const [a, b] = seats;
  console.log(`seats: ${a.name} waited ${a.waits} times, ${b.name} waited ${b.waits} times`);
  if (slowSeat >= 0) {
    const fast = seats[1 - slowSeat];
    const slow = seats[slowSeat];
    check(fast.waits > 0 && fast.from.event > 1, `${fast.name}: with a slow seat upstream some picks are answered waiting and the pack comes as an event (${fast.waits} waits, ${fast.from.event} events read)`);
    check(slow.queuedSeen > 0, `${slow.name}: the slow seat is told of packs queued behind the one it holds (${slow.queuedSeen} views)`);
  }
  if (clockOutPick > 0) check(seats[Math.max(slowSeat, 0)].autoPicked.length === 1 && seats[1 - Math.max(slowSeat, 0)].autoPicked.length === 0, "the seat that sat out has one auto-pick and the other seat none");
}
const decks = new Map();
for (const [i, s] of seats.entries()) decks.set(s, await build(s, pools[i]));
if (lastTurn > 0) await play(seats, decks);

for (const s of seats) {
  await s.call("forge_disconnect");
  console.log(`${s.name} events: ${JSON.stringify(s.eventKinds)}`);
  console.log(`${s.name} calls: ${JSON.stringify(s.counts)}`);
  await s.close();
}
for (const what of failures) console.log(`FAILED: ${what}`);
console.log(failures.length ? `${failures.length} check(s) failed` : "all checks passed");
process.exit(failures.length ? 1 : 0);
