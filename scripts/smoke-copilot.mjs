// Runs a copilot against a real host with no model: one server hosts with `copilot` and plays "Opponent", a second
// server plays "Johnny", the watched seat. At each of Johnny's prompts it compares forge_copilot_view on the first
// server with Johnny's own view, searches the copilot view for the names in Opponent's hidden hand, and checks that a
// waiting forge_copilot_view returns when Johnny's prompt changes. It starts and stops both servers itself.
//   node scripts/smoke-copilot.mjs [turns]
// Build first, and set FORGE_JAR, FORGE_HOME and FORGE_BRIDGE_JAR (forge-agent-bridge 0.1.11).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const lastTurn = Number(process.argv[2] ?? 4);
const WATCHED = "Johnny";
const DISCLOSURE = `${WATCHED} has a copilot`;
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A server of this checkout over HTTP, with a bridge of its own. Resolves with its URL once it listens. */
function server(label, port) {
  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "streamableHttp"], {
    env: { ...process.env, FORGE_MCP_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => {
      const text = String(d);
      if (/MATCH_HOST_READY|\[copilot\]/.test(text)) console.log(`${label} host: ${text.trim().split("\n").find((l) => /MATCH_HOST_READY|\[copilot\]/.test(l))}`);
      if (text.includes("forge-mcp-server on ")) resolve({ url: `http://127.0.0.1:${port}/mcp`, stop: () => child.kill() });
    });
    child.on("exit", (code) => reject(new Error(`${label} server exited with code ${code}`)));
  });
}

async function seat(name, url, deck) {
  const withHeaders = (target, init) => {
    const headers = new globalThis.Headers(init?.headers);
    if (String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", "forge.your_move");
    return fetch(target, { ...init, headers });
  };
  const client = new Client({ name: "smoke", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: withHeaders }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args }, { timeout: 180_000 });
    if (res.isError) throw new Error(`${name} ${tool} ${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  };
  const pending = async () => {
    const res = await client.request({ method: "events/poll", params: { name: "forge.your_move", arguments: {}, cursor: null } }, z.looseObject({}));
    return res.events?.at(-1)?.data;
  };
  const tools = async () => (await client.listTools()).tools;
  return { name, deck, call, pending, tools, landTurn: -1, tried: new Set(), close: () => client.close() };
}

/** One action for the prompt in `v`, by the policy of smoke-two-seats.mjs. */
async function act(s, v) {
  const at = v.promptCount;
  const go = (args) => s.call("forge_game_act", { ...args, at });
  const prompt = String(v.prompt ?? "");
  if (v.pendingDecision) return s.call("forge_game_decide", { id: v.pendingDecision.id, choices: [0] });
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
    return s.call("forge_game_act", { action: "ok", endTurn: true });
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

const names = (cards) => (cards ?? []).map((c) => String(c.name)).sort();
const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
const failures = [];
const fail = (line) => {
  failures.push(line);
  console.log(`FAILED ${line}`);
};

/** Why the copilot view differs from the watched seat's own view of the same prompt, or null. */
function difference(copilot, own) {
  if (copilot.promptCount !== own.promptCount) return `promptCount ${copilot.promptCount} against ${own.promptCount}`;
  if (copilot.prompt !== own.prompt) return `prompt ${JSON.stringify(copilot.prompt)} against ${JSON.stringify(own.prompt)}`;
  if (!same(copilot.buttons, own.buttons)) return `buttons ${JSON.stringify(copilot.buttons)} against ${JSON.stringify(own.buttons)}`;
  if (own.hand && !same(names(copilot.hand), names(own.hand))) return `hand ${names(copilot.hand)} against ${names(own.hand)}`;
  return null;
}

for (const key of ["FORGE_JAR", "FORGE_HOME", "FORGE_BRIDGE_JAR"]) if (!process.env[key]) throw new Error(`Set ${key}.`);
const [hostPort, portA, portB] = [await freePort(), await freePort(), await freePort()];
const servers = await Promise.all([server("A", portA), server("B", portB)]);
const a = await seat("Opponent", servers[0].url, { id: "precons/Abzan Siege" });
const b = await seat(WATCHED, servers[1].url, { id: "precons/Goblin Mob" });
const seats = [a, b];

try {
  const copilotTools = (await a.tools()).filter((t) => t.name.includes("copilot")).map((t) => t.name);
  console.log(`copilot tools on the server: ${copilotTools.join(", ")}`);
  const before = await a.call("forge_copilot_view");
  console.log(`before forge_host: ${JSON.stringify(before)}`);

  const hosted = await a.call("forge_host", { port: hostPort, copilot: WATCHED });
  console.log(`forge_host -> ${JSON.stringify(hosted)}`);
  if (/[0-9a-f]{64}/.test(JSON.stringify(hosted))) fail("forge_host's answer carries the token");
  console.log(`in the lobby, before a game: ${JSON.stringify(await a.call("forge_copilot_view"))}`);

  for (const s of seats) {
    await s.call("forge_status");
    await s.call("forge_connect", { host: "127.0.0.1", port: hostPort, name: s.name });
    const deck = await s.call("forge_lobby_deck", s.deck);
    console.log(`${s.name} deck ${deck.deck} size ${deck.size}`);
  }
  for (const s of seats) await s.call("forge_lobby_ready", { ready: true });

  let compared = 0;
  let withHand = 0;
  let secrecy = 0;
  let waits = 0;
  let logLines = 0;
  const comparedPrompts = new Set();
  const hiddenNames = new Set();
  let turn = 0;
  for (let step = 0; step < 600 && turn < lastTurn; step++) {
    let moved = false;
    for (const s of seats) {
      const status = await s.call("forge_status");
      const g = status.game;
      if (!g?.inGame || g.gameOver) continue;
      turn = Math.max(turn, g.turn ?? 0);
      if (g.waiting) continue;
      const event = await s.pending();
      if (!event || event.promptCount !== g.promptCount) continue;

      // No name from Opponent's hidden hand. The copilot view is read first, so a card played since is not counted.
      let view = await a.call("forge_copilot_view");
      if (view.watching) {
        const state = await a.call("forge_game_state");
        const open = new Set((view.hand ?? []).map((c) => c.name));
        for (const p of state.players ?? []) for (const c of [...(p.battlefield ?? []), ...(p.graveyard ?? [])]) open.add(c.name);
        for (const item of state.stack ?? []) open.add(item.source);
        const hidden = names((state.players ?? []).find((p) => p.isMe)?.hand).filter((n) => !open.has(n));
        const text = JSON.stringify(view);
        for (const name of hidden) if (text.includes(name)) fail(`the copilot view names ${name} from Opponent's hand: ${text.slice(0, 300)}`);
        if (hidden.length) secrecy++;
        for (const name of hidden) hiddenNames.add(name);
        logLines += view.since?.log?.length ?? 0;
        if (view.since?.log && logLines === view.since.log.length) console.log(`first log lines on the copilot view: ${JSON.stringify(view.since.log.slice(0, 3))}`);
      }

      let waiting;
      if (s === b) {
        // Johnny's prompt against the copilot view of it.
        let why = difference(view, event);
        for (let attempt = 0; why && attempt < 3; attempt++) {
          await sleep(300);
          view = await a.call("forge_copilot_view");
          why = difference(view, event);
        }
        if (why) fail(`at Johnny's prompt #${event.promptCount}: ${why}`);
        else {
          compared++;
          if (event.hand) withHand++;
          comparedPrompts.add(String(event.prompt).replace(/\n/g, " / ").replace(/[0-9]+/g, "#").slice(0, 70));
        }
        if (waits < 4) waiting = { since: view.revision, started: Date.now(), answer: a.call("forge_copilot_view", { since: view.revision, timeout: 30 }) };
      }
      await act(s, event);
      if (waiting) {
        const next = await waiting.answer;
        const ms = Date.now() - waiting.started;
        if (next.unchanged || next.revision === waiting.since) fail(`a waiting forge_copilot_view did not see Johnny's prompt change in ${ms} ms`);
        else console.log(`wait ${++waits}: since ${waiting.since} returned revision ${next.revision} after ${ms} ms, prompt ${JSON.stringify(String(next.prompt).slice(0, 50))}`);
      }
      moved = true;
    }
    if (!moved) await sleep(300);
  }

  console.log(`compared equal at ${compared} of Johnny's prompts through turn ${turn}, ${withHand} with the hand`);
  for (const p of comparedPrompts) console.log(`  compared: ${p}`);
  console.log(`secrecy checks ${secrecy}, hidden names checked: ${[...hiddenNames].join(", ")}`);
  console.log(`log lines on copilot views: ${logLines}`);
  if (compared < 5) fail(`only ${compared} prompts compared`);
  if (withHand < 2) fail(`only ${withHand} prompts compared with the hand`);
  if (secrecy < 5) fail(`only ${secrecy} secrecy checks`);
  if (waits < 1) fail("no waiting forge_copilot_view was tried");
  const unchanged = await a.call("forge_copilot_view", { since: (await a.call("forge_copilot_view")).revision, timeout: 1 });
  console.log(`wait with nothing happening: unchanged ${unchanged.unchanged}, revision ${unchanged.revision}`);

  for (const s of seats) {
    const chat = ((await s.call("forge_status")).chat ?? []).map((l) => (typeof l === "string" ? l : l.text));
    const told = chat.filter((l) => String(l).includes(DISCLOSURE));
    console.log(`${s.name} chat: ${told.length} disclosure line(s): ${JSON.stringify(told[0] ?? null)}`);
    if (told.length !== 1) fail(`${s.name} was told ${told.length} times`);
  }

  await a.call("forge_game_act", { action: "concede" });
  await sleep(3000);
  for (const s of seats) await s.call("forge_game_act", { action: "quit" });
  await sleep(1500);
  console.log(`after the match: ${JSON.stringify(await a.call("forge_copilot_view"))}`);
  for (const s of seats) await s.call("forge_disconnect");
  console.log(`forge_host_stop -> ${JSON.stringify(await a.call("forge_host_stop"))}`);
  console.log(`after forge_host_stop: ${JSON.stringify(await a.call("forge_copilot_view"))}`);
} finally {
  await Promise.all(seats.map((s) => s.close().catch(() => undefined)));
  for (const s of servers) s.stop();
}
console.log(failures.length ? `FAILED: ${failures.length} check(s)` : "PASSED: every check");
process.exit(failures.length ? 1 : 0);
