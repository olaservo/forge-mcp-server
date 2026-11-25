// Plays one seat against Forge's AI on a host this script starts with forge_host, with a fixed policy and no model.
// The games are not fixed: what the AI draws decides how much of this a run shows.
// It runs what the tests fake: forge_host with ai against the real bridge jar, the AI's turns, and a best of three
// where the seat alone continues.
//   node scripts/smoke-ai-seat.mjs [turns]
// Needs FORGE_JAR, FORGE_HOME and FORGE_BRIDGE_JAR, and a build in dist/. It starts its own server, on free ports.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const lastTurn = Number(process.argv[2] ?? 8);
const SEAT = "SmokeSeat";
const SEAT_DECK = "precons/Lightning Aggro";
/** A deck of cheap creatures for the AI of the first game, so that it attacks and blocks in the first turns. */
const AI_DECK = "precons/Goblin Mob";
const AI_DECK_NAME = "Goblin Mob";
/** A precon of 41 cards, which Constructed does not take. */
const SHORT_DECK = "precons/Rapid Fire";
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

for (const name of ["FORGE_JAR", "FORGE_HOME", "FORGE_BRIDGE_JAR"]) {
  if (!process.env[name]) throw new Error(`Set ${name}.`);
}

const failures = [];
function check(ok, what) {
  console.log(`${ok ? "ok    " : "FAILED"} ${what}`);
  if (!ok) failures.push(what);
}

// The server, with nothing of another server's: no token, no bridge URL, no log or subscriptions file.
const mcpPort = await freePort();
const env = { ...process.env, FORGE_MCP_PORT: String(mcpPort) };
for (const name of ["FORGE_MCP_TOKEN", "FORGE_MCP_PROXY_TOKEN", "FORGE_BRIDGE_URL", "FORGE_AUTO_JOIN", "FORGE_MCP_LOG", "FORGE_MCP_SUBSCRIPTIONS", "FORGE_HOSTING"]) delete env[name];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverLog = join(tmpdir(), `smoke-ai-seat-${mcpPort}.log`);
const server = spawn(process.execPath, ["dist/index.js", "streamableHttp"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
const logFile = createWriteStream(serverLog);
server.stdout.pipe(logFile);
server.stderr.pipe(logFile);
console.log(`server on port ${mcpPort}, its output in ${serverLog}`);

const withHeaders = (target, init) => {
  const headers = new globalThis.Headers(init?.headers);
  if (String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", "forge.your_move");
  return fetch(target, { ...init, headers });
};
let client;
for (let i = 0; ; i++) {
  try {
    client = new Client({ name: "smoke-ai-seat", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { fetch: withHeaders }));
    break;
  } catch (e) {
    if (i === 40) throw e;
    await sleep(500);
  }
}

const counts = {};
/** Calls a tool. A tool error is thrown unless `allowError`, which returns its text. */
async function call(tool, args = {}, allowError = false) {
  counts[tool] = (counts[tool] ?? 0) + 1;
  const res = await client.callTool({ name: tool, arguments: args }, { timeout: 240_000 });
  if (res.isError && allowError) return { error: JSON.stringify(res.content) };
  if (res.isError) throw new Error(`${tool} ${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
  return res.structuredContent;
}
/** Without a cursor a poll answers the event for what the seat is asked now. With one, the events after it. */
async function poll(cursor = null) {
  const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor } }, z.looseObject({}));
  return { events: (res.events ?? []).map((e) => e.data), cursor: res.cursor };
}
const events = async () => (await poll()).events;

let stale = 0;
/** Prompts whose event had no buttons and no `selection`, where forge_game_state had one. */
const withoutSelection = [];
/** Prompts with no button whose event had its `selection`. */
const withSelection = [];
const told = [];
/** The AI's name in the game being played, and its spells and abilities the seat was asked about, as `turn:source`. */
let ai;
const askedAbout = new Set();
function show(did, v) {
  if (v.stale) stale++;
  if (!v.waiting && String(v.prompt ?? "").startsWith("Priority")) {
    for (const item of v.stack ?? []) if (item.by === ai) askedAbout.add(`${v.turn}:${item.source}`);
  }
  const flags = ["waiting", "stale", "refused", "gameOver"].filter((k) => v[k]).join(",");
  const prompt = String(v.prompt ?? "").replace(/\n/g, " / ").slice(0, 80);
  console.log(`${did.padEnd(40)} -> #${v.promptCount} t${v.turn ?? "-"} ${v.phase ?? "-"} [${flags}] ${prompt}`);
  for (const line of v.since?.log ?? []) console.log(`      log: ${line}`);
  told.push(...(v.since?.log ?? []));
  if (v.since?.earlier) console.log(`      (${v.since.earlier} earlier log lines not shown)`);
  if (v.stack) console.log(`      stack: ${JSON.stringify(v.stack)}`);
}

const isInstant = (c) => String(c.type).includes("Instant");
const isLand = (c) => String(c.type).includes("Land");
const manaValue = (c) => (String(c.manaCost ?? "").match(/\d+|[WUBRGC]/g) ?? []).reduce((sum, part) => sum + (/\d/.test(part) ? Number(part) : 1), 0);

/** One action for the prompt in `v`: play a land, cast what is offered, attack with everything, pass. Instants are kept for the AI's spells. */
async function act(s, given) {
  let v = given;
  const at = v.promptCount;
  const go = async (args) => {
    const out = await call("forge_game_act", { ...args, at });
    show(JSON.stringify(args), out);
    return out;
  };
  const prompt = String(v.prompt ?? "");
  if (!v.pendingDecision && !v.buttons && v.selection && !prompt.startsWith("Priority")) {
    withSelection.push(`#${at} ${prompt.replace(/\n/g, " / ").slice(0, 60)}: players ${JSON.stringify((v.selection.players ?? []).map((p) => p.name))}, ${(v.selection.cards ?? []).length} cards`);
  }
  if (!v.pendingDecision && !v.buttons && !v.selection && !prompt.startsWith("Priority")) {
    // A prompt answered by picking a card or a player, in an event that does not say which. The state does.
    const state = await call("forge_game_state");
    if (state.selection) {
      withoutSelection.push(`#${at} ${prompt.replace(/\n/g, " / ").slice(0, 100)}`);
      v = { ...v, selection: state.selection };
    }
  }
  if (v.pendingDecision) {
    const out = await call("forge_game_decide", { id: v.pendingDecision.id, choices: [0] });
    show(`decide ${v.pendingDecision.kind} 0`, out);
    return out;
  }
  const hand = v.hand ?? [];
  const playable = new Set((v.actionable ?? []).map((c) => c.id));
  const theirs = (v.stack ?? []).filter((item) => item.by === ai);
  if (prompt.startsWith("Priority") && theirs.length) {
    // Asked with a spell or ability of the AI on the stack.
    const answer = hand.find((c) => isInstant(c) && playable.has(c.id) && !s.tried.has(`${at}:${c.id}`));
    if (answer) {
      s.askedWithInstant++;
      s.tried.add(`${at}:${answer.id}`);
      return go({ action: "selectCard", id: answer.id, pay: "auto", pass: true });
    }
    return go({ action: "ok" });
  }
  if (prompt.startsWith("Priority") && v.activePlayer === SEAT && String(v.phase).startsWith("MAIN") && !v.stack) {
    const land = hand.find(isLand);
    if (land && s.landTurn !== v.turn) {
      s.landTurn = v.turn;
      return go({ action: "selectCard", id: land.id });
    }
    const spell = hand.find((c) => !isLand(c) && !isInstant(c) && playable.has(c.id) && !s.tried.has(`${v.turn}:${c.id}`));
    if (spell) {
      s.tried.add(`${v.turn}:${spell.id}`);
      return go({ action: "selectCard", id: spell.id, pay: "auto", pass: true });
    }
    return go({ action: "ok" });
  }
  if (/creatures to attack/.test(prompt)) {
    await go({ action: "alphaStrike" });
    const out = await call("forge_game_act", { action: "ok" });
    show('{"action":"ok"} after alphaStrike', out);
    return out;
  }
  if (v.selection && (v.selection.min ?? 0) > (v.selection.chosen?.length ?? 0)) {
    const player = (v.selection.players ?? []).find((p) => p.name !== SEAT);
    if (player) return go({ action: "selectPlayer", id: player.id, pay: "auto", pass: true });
    const card = (v.selection.cards ?? [])[0];
    if (card) return go({ action: "selectCard", id: card.id, pay: "auto", pass: true });
  }
  if (v.buttons?.ok) return go({ action: "ok" });
  if (v.buttons?.cancel) return go({ action: "cancel" });
  s.idle = s.idleAt === at ? s.idle + 1 : 1;
  s.idleAt = at;
  if (s.idle > 20) throw new Error(`Nothing to answer prompt #${at} with: ${JSON.stringify(v).slice(0, 600)}`);
  return v;
}

/** Hosts, sits and readies. Answers the host's state and the lobby as the seat sees it. */
async function sit(hostArgs) {
  const hosted = await call("forge_host", hostArgs);
  console.log(`forge_host ${JSON.stringify(hostArgs)} -> ${JSON.stringify(hosted)}`);
  await call("forge_connect", { host: "127.0.0.1", port: hostArgs.port, name: SEAT });
  const deck = await call("forge_lobby_deck", { id: SEAT_DECK });
  console.log(`seat deck ${deck.deck}, ${deck.size} cards`);
  // The lobby as the seat sees it, read before it readies: the match starts 3 seconds after.
  let joined;
  for (let i = 0; i < 20 && !joined?.lobby?.slots; i++) {
    joined = await call("forge_status");
    if (!joined.lobby?.slots) await sleep(250);
  }
  console.log(`lobby slots: ${JSON.stringify(joined.lobby?.slots)}`);
  await call("forge_lobby_ready", { ready: true });
  return { hosted, joined };
}

/** Waits for the prompt of game `number` that the seat is asked, and answers the decisions before the first priority. */
async function untilAsked(number) {
  const s = { landTurn: -1, tried: new Set(), askedWithInstant: 0 };
  for (let step = 0; step < 300; step++) {
    const g = (await call("forge_status")).game;
    if (g?.inGame && !g.gameOver && !g.waiting && (g.match?.game ?? 1) === number) {
      const event = (await events()).at(-1);
      if (event && event.promptCount === g.promptCount) {
        if (String(event.prompt).startsWith("Priority")) return event;
        await act(s, event);
        continue;
      }
    }
    await sleep(300);
  }
  throw new Error(`The seat was not asked in game ${number}.`);
}

/** Concedes and answers the bridge's game summary once the game is over, with the game_over event under `event`. */
async function concede(label) {
  const { cursor } = await poll();
  show(label, await call("forge_game_act", { action: "concede" }));
  for (let i = 0; i < 60; i++) {
    const g = (await call("forge_status")).game;
    const event = (await poll(cursor)).events.findLast((e) => e.kind === "game_over");
    if (g?.gameOver && g.finished && event) return { ...g, event };
    await sleep(250);
  }
  throw new Error("The game did not end on the concession, or no game_over event came.");
}

try {
  console.log(`forge_status: bridge ${JSON.stringify((await call("forge_status")).bridge)}`);

  // 1. One game against an AI seat with a deck given by its id.
  const hostPort = await freePort();
  const { hosted, joined } = await sit({ port: hostPort, ai: 1, aiDecks: [AI_DECK] });
  const aiSeat = hosted.aiSeats?.[0];
  check(hosted.running === true && hosted.ai === 1, "forge_host answers a running host with ai 1");
  check(hosted.aiSeats?.length === 1 && aiSeat.slot === 1 && aiSeat.name.length > 0 && aiSeat.deck === AI_DECK_NAME, `aiSeats names the AI and the deck given by id: ${JSON.stringify(hosted.aiSeats)}`);
  ai = aiSeat.name;
  const aiSlot = (joined.lobby?.slots ?? []).find((slot) => slot.type === "AI");
  check(aiSlot?.name === ai && aiSlot?.deckName === aiSeat.deck, "the seat's lobby shows the same AI name and deck");
  const again = await call("forge_host", { port: hostPort, ai: 1, aiDecks: [AI_DECK] });
  check(JSON.stringify(again.aiSeats) === JSON.stringify(hosted.aiSeats), "forge_host with the same settings answers the same host");

  const s = { landTurn: -1, tried: new Set(), askedWithInstant: 0 };
  // What the seat held after each of its actions: the untapped lands and the instants they pay for. Its lands stay
  // as they are through the AI's turn, so the last of these from before an AI spell says whether the seat could answer.
  const held = [];
  // Spells the AI cast, by the turn the log gives. Whether the seat was asked is known one prompt later.
  let casts = [];
  const judged = new Set();
  const unasked = [];
  let turn = 0;
  let logTurn = 0;
  let over = false;
  let seen = 0;
  const wasAsked = (cast) => [...askedAbout].some((key) => key.startsWith(`${cast.turn}:`) && cast.spell.startsWith(key.slice(key.indexOf(":") + 1)));
  // An AI short of lands can go the first turns without combat, so the game runs up to 6 turns longer for it.
  const fought = () => told.some((line) => new RegExp(`${ai} assigned .* to (attack|block)`).test(line));
  for (let step = 0; step < 1500 && (turn <= lastTurn || (turn <= lastTurn + 6 && !fought())) && !over; step++) {
    const g = (await call("forge_status")).game;
    over = g?.gameOver === true;
    if (!g?.inGame || over) {
      await sleep(300);
      continue;
    }
    turn = Math.max(turn, g.turn ?? 0);
    const event = g.waiting ? undefined : (await events()).at(-1);
    if (!event || event.promptCount !== g.promptCount) {
      await sleep(200);
      continue;
    }
    show(`event ${event.kind}`, event);
    unasked.push(...casts.filter((cast) => !wasAsked(cast)));
    casts = [];
    await act(s, event);
    const full = await call("forge_game_state", { full: true });
    const me = (full.players ?? []).find((p) => p.isMe);
    const lands = (me?.battlefield ?? []).filter((c) => isLand(c) && !c.tapped).length;
    held.push({ turn: full.turn, untappedLands: lands, instants: (me?.hand ?? []).filter((c) => isInstant(c) && manaValue(c) <= lands).map((c) => c.name) });
    for (const line of told.slice(seen)) {
      logTurn = Number(/Turn: Turn (\d+)/.exec(line)?.[1] ?? logTurn);
      const cast = new RegExp(`${ai} cast (.+?)(?: targeting .*)?$`).exec(line);
      if (!cast || judged.has(`${logTurn}:${line}`)) continue;
      judged.add(`${logTurn}:${line}`);
      const then = held.findLast((h) => h.turn <= logTurn);
      casts.push({ line, spell: cast[1], turn: logTurn, untappedLands: then?.untappedLands, instants: then?.instants ?? [] });
    }
    seen = told.length;
  }
  unasked.push(...casts.filter((cast) => !wasAsked(cast)));

  const aiCasts = told.filter((line) => line.includes(`${ai} cast `));
  const aiAttacks = told.filter((line) => new RegExp(`${ai} assigned .* to attack`).test(line));
  const aiBlocks = told.filter((line) => new RegExp(`${ai} assigned .* to block`).test(line));
  console.log(`reached turn ${turn}${over ? ", game over" : ""}. AI casts ${aiCasts.length}, attacks ${aiAttacks.length}, blocks ${aiBlocks.length}`);
  console.log(`asked with the AI's spell or ability on the stack: ${JSON.stringify([...askedAbout])}, answered with an instant ${s.askedWithInstant} times`);
  console.log(`AI casts the seat was not asked about: ${JSON.stringify(unasked)}`);
  check(aiCasts.length > 0, `the AI cast spells: ${aiCasts.length} lines in since.log`);
  check(aiAttacks.length + aiBlocks.length > 0, `the AI attacked or blocked: ${aiAttacks.length} attacks, ${aiBlocks.length} blocks in since.log`);
  check(stale === 0, `no action answered stale: ${stale}`);
  const missed = unasked.filter((u) => u.instants.length > 0);
  check(missed.length === 0, `the seat was asked about each AI spell it had an instant and the lands for: ${missed.length} missed`);
  console.log(`events for a prompt with no button, with \`selection\`: ${JSON.stringify(withSelection)}`);
  check(withoutSelection.length === 0, `no event for a prompt with no button lacked a \`selection\` the state had: ${JSON.stringify(withoutSelection)}`);
  if (askedAbout.size === 0) console.log("note: the seat was never asked with an AI spell on the stack in this game");

  if (!over) await concede("concede");
  console.log(`quit -> ${JSON.stringify(await call("forge_game_act", { action: "quit" })).slice(0, 200)}`);
  console.log(`forge_host_stop -> ${JSON.stringify(await call("forge_host_stop"))}`);
  await call("forge_disconnect");

  // 2. What is refused: by the server before it starts a host, and by the host for a deck that is not legal, with its own line.
  const refused = await call("forge_host", { port: hostPort, ai: 1, limited: true }, true);
  check(String(refused.error).includes("no AI seats in a Limited lobby"), `ai in a Limited lobby is refused: ${refused.error}`);
  const illegal = await call("forge_host", { port: hostPort, ai: 1, aiDecks: [SHORT_DECK] }, true);
  check(String(illegal.error).includes("exited with code 2") && String(illegal.error).includes("is not legal here"), `a 41-card AI deck stops the host with its reason: ${illegal.error}`);
  check((await call("forge_host_stop")).running === false, "no host is left running after the refusal");

  // 3. A best of three against an AI with a precon the host picks. The seat concedes game 1 and continues.
  const port3 = await freePort();
  const bo3 = await sit({ port: port3, ai: 1, games: 3 });
  const ai3 = bo3.hosted.aiSeats?.[0]?.name;
  ai = ai3;
  check(bo3.hosted.games === 3 && bo3.hosted.aiSeats?.[0]?.deck?.length > 0, `the host plays 3 games and picked a precon for the AI: ${JSON.stringify(bo3.hosted.aiSeats)}`);
  await untilAsked(1);
  const conceded = await concede("concede game 1");
  console.log(`match after game 1: ${JSON.stringify(conceded.match)}`);
  check(conceded.gameOver === true && conceded.winner === ai3, "game 1 is over and the AI won it");
  check(conceded.match?.gamesPerMatch === 3 && conceded.match?.game === 1 && conceded.match?.over === false, "match after game 1: game 1 of 3, not over");
  check(conceded.match?.wins?.[ai3] === 1 && conceded.match?.wins?.[SEAT] === 0, `the score is AI 1, seat 0: ${JSON.stringify(conceded.match?.wins)}`);
  const gameOver = conceded.event;
  console.log(`game_over event: ${JSON.stringify(gameOver)}`);
  check(gameOver?.matchOver === false && gameOver?.score?.[ai3] === 1 && gameOver?.score?.[SEAT] === 0, "the game_over event has matchOver false and the score");
  await sleep(2000);
  const waiting = (await call("forge_status")).game;
  check(waiting?.gameOver === true && waiting?.match?.game === 1, "the host starts no game before the seat continues");
  show("continue", await call("forge_game_act", { action: "continue" }));
  const second = await untilAsked(2);
  const state = await call("forge_game_state");
  console.log(`game 2: prompt "${String(second.prompt).slice(0, 60)}", match ${JSON.stringify(state.match)}`);
  check(state.match?.game === 2 && state.match?.over === false && state.match?.wins?.[ai3] === 1, "game 2 is open with the AI one game up");
  const last = await concede("concede game 2");
  check(last.match?.over === true && last.match?.wins?.[ai3] === 2, `the match is over at AI 2: ${JSON.stringify(last.match)}`);
  const end = last.event;
  console.log(`game_over event: ${JSON.stringify(end)}`);
  check(end?.matchOver === true && end?.score?.[ai3] === 2, "the last game_over event has matchOver true");
  console.log(`quit -> ${JSON.stringify(await call("forge_game_act", { action: "quit" })).slice(0, 200)}`);
  console.log(`forge_host_stop -> ${JSON.stringify(await call("forge_host_stop"))}`);
  await call("forge_disconnect");
  console.log(`calls: ${JSON.stringify(counts)}`);
} catch (e) {
  failures.push(String(e));
  console.log(`FAILED ${e.stack ?? e}`);
} finally {
  await call("forge_host_stop").catch(() => undefined);
  await client.close().catch(() => undefined);
  server.kill();
}
console.log(failures.length ? `${failures.length} FAILED` : "all checks passed");
process.exitCode = failures.length ? 1 : 0;
