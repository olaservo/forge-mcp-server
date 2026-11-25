import { describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import { MoveTracker, type SeatStatus } from "../src/seat-events.js";
import { withoutIdleDraft } from "../src/tools/index.js";
import { connect, fakeBridge } from "./helpers.js";

const summary = {
  inGame: true,
  finished: false,
  prompt: "Priority: Me\nTurn: 3 (Me)\nPhase: Main phase, precombat\nStack: Empty",
  promptCount: 12,
  waiting: false,
  priorityPrompt: true,
  buttons: { ok: "OK", okEnabled: true, cancel: "End Turn", cancelEnabled: true },
  incorrectActions: 0,
  messages: [],
  messageCount: 0,
  logCount: 0,
  turn: 3,
  phase: "MAIN1",
  activePlayer: "Me",
  gameOver: false,
  hasPriority: true,
  stops: "default",
};
const game = { ...summary, players: [{ id: 0, name: "Me", life: 20, isMe: true, mana: {}, battlefield: [], graveyard: [], hand: [] }], stack: [] };

describe("forge_game_act", () => {
  it("sends its arguments to the bridge and returns the view of the game after it", async () => {
    const { bridge, calls } = fakeBridge({ "POST /game/act": summary, "GET /game": game });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "selectCard", id: 4, pay: "auto", pass: true, at: 11 } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(calls.find((c) => c.path === "/game/act")?.body).toEqual({ action: "selectCard", id: 4, pay: "auto", pass: true, at: 11 });
    expect(res.structuredContent).toMatchObject({ promptCount: 12, buttons: { ok: "OK", cancel: "End Turn" }, life: { Me: 20 } });
    expect(res.structuredContent).not.toHaveProperty("autoPass");

    await client.callTool({ name: "forge_game_act", arguments: { action: "ok", once: true } });
    expect(calls.filter((c) => c.path === "/game/act").at(-1)?.body).toEqual({ action: "ok", once: true });
    await client.callTool({ name: "forge_game_act", arguments: { action: "ok", endTurn: true } });
    expect(calls.filter((c) => c.path === "/game/act").at(-1)?.body).toEqual({ action: "ok", endTurn: true });
    await client.close();
  });

  it("says so when the bridge is too old for an argument", async () => {
    const { stops: _none, ...old } = summary;
    const client = await connect(fakeBridge({ "POST /game/act": old, "GET /game": game }).bridge);
    const plain = await client.callTool({ name: "forge_game_act", arguments: { action: "ok" } });
    expect(plain.isError).toBeFalsy();
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "ok", once: true } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("forge-agent-bridge 0.1.10");
    await client.close();
  });

  it("does not blame the bridge when the game ended during the action", async () => {
    const gone = { inGame: false, finished: false, prompt: "", promptCount: 70, waiting: false };
    const client = await connect(fakeBridge({ "POST /game/act": gone, "GET /game": gone, "GET /game/log": { log: [] } }).bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "selectCard", id: 41, at: 69 } });
    expect(JSON.stringify(res.content)).not.toContain("0.1.10");
    await client.close();
  });

  it("marks an action the bridge did not send", async () => {
    const client = await connect(fakeBridge({ "POST /game/act": { ...summary, stale: true }, "GET /game": game }).bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "ok", at: 3 } });
    expect(res.structuredContent).toMatchObject({ stale: true, promptCount: 12 });
    await client.close();
  });

  it("answers quit with the lobby the seat is back in", async () => {
    const lobby = { mySlot: 0, slots: [{ index: 0, name: "Me", ready: false }] };
    const over = { ...summary, inGame: false, finished: true, gameOver: true };
    const client = await connect(fakeBridge({ "POST /game/act": over, "GET /status": { revision: 9, lobby, game: over } }).bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "quit" } });
    expect(res.structuredContent).toEqual({ left: true, lobby });
    await client.close();
  });
});

describe("a status", () => {
  it("has no draft block unless the seat has a draft or a pool", () => {
    const idle = { seatIndex: -1, packNumber: 0, pickPending: false, poolReceived: false, picks: [] };
    expect(withoutIdleDraft({ revision: 1, draft: idle })).toEqual({ revision: 1 });
    for (const draft of [{ ...idle, pickPending: true }, { ...idle, poolReceived: true }, { ...idle, packNumber: 2 }, { ...idle, picks: ["Shock"] }]) {
      expect(withoutIdleDraft({ revision: 1, draft })).toEqual({ revision: 1, draft });
    }
  });
});

describe("forge.your_move with the view", () => {
  const status = { revision: 40, game: summary } as unknown as SeatStatus;

  it("carries what the seat needs beside the summary", async () => {
    const log = new EventLog();
    const moves = new MoveTracker(log);
    const event = await moves.observeWith(status, async () => ({ promptCount: 12, life: { Me: 20 } }));
    expect(event?.data).toMatchObject({ kind: "priority", revision: 40, turn: 3, phase: "MAIN1", promptCount: 12, life: { Me: 20 } });
    expect(moves.current()).toBe(event);
    expect(await moves.observeWith(status, async () => ({}))).toBeUndefined();
  });

  it("is still emitted when the view cannot be read", async () => {
    const moves = new MoveTracker(new EventLog());
    const event = await moves.observeWith(status, async () => {
      throw new Error("bridge down");
    });
    expect(event?.data).toEqual({ kind: "priority", prompt: summary.prompt, revision: 40, turn: 3, phase: "MAIN1" });
  });
});

describe("forge_game_stops", () => {
  const stops = { stops: "default", own: ["MAIN1", "COMBAT_DECLARE_BLOCKERS", "MAIN2"], opponent: ["COMBAT_BEGIN", "COMBAT_DECLARE_ATTACKERS", "COMBAT_DECLARE_BLOCKERS", "END_OF_TURN"] };
  const custom = { stops: "custom", own: stops.own, opponent: ["END_OF_TURN"] };

  it("returns the stops and changes nothing without arguments", async () => {
    const { bridge, calls } = fakeBridge({ "GET /game/stops": stops, "POST /game/stops": custom, "GET /game": game });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_stops", arguments: {} });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(res.structuredContent).toEqual(stops);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /game/stops"]);
    await client.close();
  });

  it("sends the lists it was given and returns what the seat is asked afterwards", async () => {
    const { bridge, calls } = fakeBridge({ "GET /game/stops": stops, "POST /game/stops": custom, "GET /game": game, "GET /game/log": { log: [] } });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_stops", arguments: { opponent: ["END_OF_TURN"] } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(calls.find((c) => c.path === "/game/stops")?.body).toEqual({ opponent: ["END_OF_TURN"] });
    expect(res.structuredContent).toMatchObject({ stops: "custom", opponent: ["END_OF_TURN"], game: { promptCount: 12, phase: "MAIN1" } });
    await client.close();
  });

  it("returns the stops alone outside a game, and refuses a name that is no step", async () => {
    const { bridge } = fakeBridge({ "POST /game/stops": custom, "GET /game": { inGame: false, prompt: "" } });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_stops", arguments: { opponent: ["END_OF_TURN"] } });
    expect(res.structuredContent).toEqual(custom);
    const bad = await client.callTool({ name: "forge_game_stops", arguments: { own: ["UNTAP"] } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("says so when the bridge is too old", async () => {
    const client = await connect(fakeBridge({}).bridge);
    const res = await client.callTool({ name: "forge_game_stops", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("forge-agent-bridge 0.1.10");
    await client.close();
  });
});
