// Plays the first turns of a game between two servers, each with a bridge of its own, with a fixed policy and no model.
// It checks the wiring between this server and the bridge: the deck brief, the view an action returns, the view in
// forge.your_move, and the pay, pass, endTurn and at arguments.
//   node scripts/smoke-two-seats.mjs <host port> <url A> <url B> [turns]
// Start a host first (forge_host or MatchHost) and both servers over HTTP with FORGE_JAR, FORGE_HOME and FORGE_BRIDGE_JAR.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const [hostPort, urlA, urlB, turnsArg] = process.argv.slice(2);
const lastTurn = Number(turnsArg ?? 6);
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

async function seat(name, url, deck) {
  const withHeaders = (target, init) => {
    const headers = new globalThis.Headers(init?.headers);
    if (String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", "forge.your_move");
    return fetch(target, { ...init, headers });
  };
  const client = new Client({ name: "smoke", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: withHeaders }));
  const counts = {};
  const call = async (tool, args = {}) => {
    counts[tool] = (counts[tool] ?? 0) + 1;
    const res = await client.callTool({ name: tool, arguments: args }, { timeout: 180_000 });
    if (res.isError) throw new Error(`${name} ${tool} ${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  };
  const pending = async () => {
    const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor: null } }, z.looseObject({}));
    return res.events?.at(-1)?.data;
  };
  return { name, deck, call, pending, counts, landTurn: -1, tried: new Set(), close: () => client.close() };
}

function show(who, did, v) {
  const flags = ["waiting", "stale", "refused", "gameOver"].filter((k) => v[k]).join(",");
  const has = ["hand", "stack", "mana", "combat", "selection", "actionable", "pendingDecision", "board", "cardText", "since"].filter((k) => v[k] !== undefined);
  const prompt = String(v.prompt ?? "").replace(/\n/g, " / ").slice(0, 90);
  console.log(`${who} ${did.padEnd(34)} -> #${v.promptCount} t${v.turn ?? "-"} ${v.phase ?? "-"} [${flags}] {${has.join(" ")}} ${prompt}`);
  for (const line of v.since?.log ?? []) console.log(`      log: ${line}`);
  if (v.since?.newInHand) console.log(`      newInHand: ${v.since.newInHand.join(", ")}`);
  if (v.stack) console.log(`      stack: ${JSON.stringify(v.stack)}`);
}

/** One action for the prompt in `v`. Returns the view it got back. */
async function act(s, v) {
  const at = v.promptCount;
  const go = async (args) => {
    const out = await s.call("forge_game_act", { ...args, at });
    show(s.name, JSON.stringify(args), out);
    return out;
  };
  const prompt = String(v.prompt ?? "");
  if (v.pendingDecision) {
    const out = await s.call("forge_game_decide", { id: v.pendingDecision.id, choices: [0] });
    show(s.name, `decide ${v.pendingDecision.kind} 0`, out);
    return out;
  }
  const hand = v.hand ?? [];
  const mine = v.activePlayer === s.name;
  if (prompt.startsWith("Priority") && mine && String(v.phase).startsWith("MAIN") && !v.stack) {
    const land = hand.find((c) => String(c.type).includes("Land"));
    if (land && s.landTurn !== v.turn) {
      s.landTurn = v.turn;
      return go({ action: "selectCard", id: land.id });
    }
    const playable = new Set((v.actionable ?? []).map((c) => c.id));
    const spell = hand.find((c) => !String(c.type).includes("Land") && playable.has(c.id) && !s.tried.has(`${v.turn}:${c.id}`));
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

const a = await seat("SeatA", urlA, { name: "Lightning Aggro" });
const b = await seat("SeatB", urlB, { id: "precons/Goblin Mob" });
const seats = [a, b];

await Promise.all(seats.map((s) => s.call("forge_status")));
for (const s of seats) {
  const joined = await s.call("forge_connect", { host: "127.0.0.1", port: Number(hostPort), name: s.name });
  console.log(`${s.name} connected, status keys: ${Object.keys(joined).join(" ")}`);
  const deck = await s.call("forge_lobby_deck", s.deck);
  console.log(`${s.name} deck ${deck.deck} size ${deck.size}: ${deck.cards?.length} card rows, "${deck.description ?? ""}"`);
  console.log(`      ${JSON.stringify(deck.cards?.find((c) => c.text))}`);
}
for (const s of seats) await s.call("forge_lobby_ready", { ready: true });

let eventsShown = 0;
let turn = 0;
for (let step = 0; step < 400 && turn < lastTurn; step++) {
  let moved = false;
  for (const s of seats) {
    const status = await s.call("forge_status");
    const g = status.game;
    if (!g?.inGame || g.gameOver) continue;
    turn = Math.max(turn, g.turn ?? 0);
    if (g.waiting) continue;
    // What the seat is asked, as its event reports it.
    const event = await s.pending();
    if (!event || event.promptCount !== g.promptCount) continue;
    if (eventsShown++ < 4) console.log(`${s.name} event ${event.kind} #${event.promptCount}: ${Object.keys(event).join(" ")}`);
    await act(s, event);
    moved = true;
  }
  if (!moved) await sleep(300);
}

const state = await a.call("forge_game_state");
console.log(`state: ${JSON.stringify(state).length} chars, cardText names ${Object.keys(state.cardText ?? {}).length}, since ${JSON.stringify(state.since ?? null).slice(0, 200)}`);
show(a.name, "concede", await a.call("forge_game_act", { action: "concede" }));
await sleep(3000);
for (const s of seats) console.log(`${s.name} quit -> ${JSON.stringify(await s.call("forge_game_act", { action: "quit" })).slice(0, 160)}`);
for (const s of seats) await s.call("forge_disconnect");
for (const s of seats) console.log(`${s.name} calls: ${JSON.stringify(s.counts)}`);
await Promise.all(seats.map((s) => s.close()));
