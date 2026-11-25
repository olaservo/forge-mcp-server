import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.js";
import { EventLog } from "../src/event-log.js";
import { MoveTracker, type SeatStatus } from "../src/seat-events.js";
import { SeatMemory } from "../src/view.js";
import { connect, fakeBridge } from "./helpers.js";

/** Recorded by forge-agent-bridge's AgentBestOfThreeTest from the first seat of a best-of-three it lost 1-2. */
const fixture = <T = Record<string, unknown>>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/bo3-${name}.json`, import.meta.url), "utf8")) as T;
const afterGameOne = fixture<SeatStatus>("GET_status_gameOver");
const afterGameThree = fixture<SeatStatus>("GET_status_matchOver");

describe("a match of more than one game", () => {
  it("says in game_over whether the match is over, and the score", () => {
    const moves = new MoveTracker(new EventLog());
    expect(moves.observe(afterGameOne)?.data).toMatchObject({ kind: "game_over", matchOver: false, score: { FirstBot: 0, SecondBot: 1 } });
    expect(moves.observe(afterGameOne)).toBeUndefined();
    // Games one and three ended on the same turn with the same winner.
    expect(moves.observe(afterGameThree)?.data).toMatchObject({ kind: "game_over", matchOver: true, score: { FirstBot: 1, SecondBot: 2 } });
  });

  it("leaves both out for a bridge that does not say", () => {
    const moves = new MoveTracker(new EventLog());
    const data = moves.observe({ revision: 9, game: { inGame: false, finished: true, gameOver: true, winner: "Agent", turn: 14 } })?.data;
    expect(data).toMatchObject({ kind: "game_over" });
    expect(data).not.toHaveProperty("matchOver");
    expect(data).not.toHaveProperty("score");
  });

  it("continue answers with the next game once it has started", async () => {
    const { bridge, calls } = fakeBridge({ "POST /game/act": fixture("POST_game_act_continue"), "GET /game": fixture("GET_game_secondGame"), "GET /game/log": { log: [] } });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "continue" } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(calls.find((c) => c.path === "/game/act")?.body).toEqual({ action: "continue" });
    expect(res.structuredContent).toMatchObject({ prompt: expect.stringContaining("keep your hand") });
    expect(res.structuredContent).not.toHaveProperty("gameOver");
    await client.close();
  });

  it("a finished game's view has where the match stands", async () => {
    const over = fixture("GET_game_matchOver");
    const client = await connect(fakeBridge({ "POST /game/act": over, "GET /game": over, "GET /game/log": { log: [] } }).bridge);
    const res = await client.callTool({ name: "forge_game_act", arguments: { action: "ok" } });
    expect(res.structuredContent).toMatchObject({ gameOver: true, winner: "SecondBot", match: { gamesPerMatch: 3, game: 3, wins: { FirstBot: 1, SecondBot: 2 }, over: true } });
    const state = await client.callTool({ name: "forge_game_state", arguments: {} });
    expect(state.structuredContent).toMatchObject({ match: { over: true } });
    await client.close();
  });

  it("forge_host refuses games on a bridge jar that ignores them", async () => {
    // The fake host answers as MatchHost did before 0.1.11.
    const client = await connect(fakeBridge({}).bridge);
    const res = await client.callTool({ name: "forge_host", arguments: { port: 36750, games: 3 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("forge-agent-bridge 0.1.11");
    const bad = await client.callTool({ name: "forge_host", arguments: { port: 36750, games: 2 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

type Json = Record<string, unknown>;
const firstGame = fixture("GET_game_firstGame");
const gameOver = fixture("GET_game_gameOver");
const secondGame = fixture("GET_game_secondGame");
/** The seat's game log as it stood in game two. Forge's client keeps one log through the match. */
const { log } = fixture<{ log: string[] }>("GET_game_log_secondGame");
const logStart = Number(secondGame.logStart);
const isResult = (line: string) => /^(Game Outcome|Match Result):/.test(line);
const isNoise = (line: string) => /^(Phase|Mana|Player Control):/.test(line);

/** The recorded games end before the first turn. This is one of them with the seat in its main phase on turn 1. */
const mainPhase = (game: Json): Json => ({ ...game, turn: 1, phase: "MAIN1", activePlayer: game.me, priorityPrompt: true, waiting: false, prompt: "Priority: FirstBot" });

/** The recorded deck is Mountain and Goblin Piker, which has no rules text. This gives the Pikers in hand one, to show when text is sent. */
function withText(game: Json): Json {
  const copy = structuredClone(game);
  const me = (copy.players as { isMe: boolean; hand: { name: string; text: string }[] }[]).find((p) => p.isMe);
  for (const card of me?.hand ?? []) if (card.name === "Goblin Piker") card.text = "Sample rules text";
  return copy;
}

/** A seat's memory over a bridge that answers `/game/log` with a recorded log, up to the `logCount` of the game last viewed. */
function seat(lines = log) {
  let count = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since") ?? 0);
    return new Response(JSON.stringify({ log: lines.slice(since, count) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const bridge = new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl });
  const memory = new SeatMemory();
  return async (game: Json) => {
    count = Number(game.logCount);
    return (await memory.view(bridge, withText(game), { commit: true })) as Json & { since?: { log?: string[]; newInHand?: string[] } };
  };
}

describe("the next game of a match", () => {
  it("is in the recordings: game two opens on the same turn as game one, with game one's lines in its log", () => {
    expect(secondGame).toMatchObject({ turn: firstGame.turn, match: { game: 2 } });
    expect(logStart).toBe(gameOver.logCount);
    expect(log.slice(0, logStart).some((l) => !isResult(l) && !isNoise(l))).toBe(true);
  });

  it("starts fresh: the opening hand, the card text, the board and only its own log lines", async () => {
    const view = seat();
    const opening = await view(firstGame);
    expect(opening.hand).toHaveLength(7);
    expect(opening.cardText).toEqual({ "Goblin Piker": "Sample rules text" });
    expect((await view(mainPhase(firstGame))).board).toBeDefined();
    expect((await view(mainPhase(firstGame))).board).toBeUndefined();
    const over = await view(gameOver);
    expect(over.since?.log?.filter(isResult).length).toBeGreaterThan(0);

    const next = await view(secondGame);
    expect(next.hand).toHaveLength(7);
    expect(next.cardText).toEqual(opening.cardText);
    expect(next.since?.newInHand).toBeUndefined();
    // Game two has no log lines yet, and the seat has read game one's.
    expect(log.slice(logStart, Number(secondGame.logCount))).toEqual([]);
    expect(next.since?.log).toBeUndefined();
    expect((await view(mainPhase(secondGame))).board).toBeDefined();
  });

  it("tells the last game's result once to a seat that did not read its end", async () => {
    const view = seat();
    await view(firstGame);
    const next = await view(secondGame);
    const earlier = log.slice(Number(firstGame.logCount), logStart);
    expect(next.since?.log).toEqual([...earlier.filter(isResult), ...log.slice(logStart, Number(secondGame.logCount)).filter((l) => !isNoise(l))].map((l) => l.trim()));
    expect((await view(mainPhase(secondGame))).since?.log).toBeUndefined();
  });

  it("has its first ask emitted", () => {
    const moves = new MoveTracker(new EventLog());
    const before = fixture<SeatStatus>("GET_status_firstGame");
    const after = fixture<SeatStatus>("GET_status_secondGame");
    moves.observe(before);
    expect(moves.observe(afterGameOne)?.data).toMatchObject({ kind: "game_over" });
    // The same turn and phase as the first game's opening.
    expect(after.game).toMatchObject({ turn: before.game?.turn, phase: before.game?.phase });
    expect(moves.observe(after)?.data).toMatchObject({ kind: "priority", turn: after.game?.turn });
    expect(moves.observe(after)).toBeUndefined();
  });
});

/** Recorded by the bridge's AgentHostedMatchTest from the first seat of two one-game matches in one lobby. */
const rematch = <T = Json>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/rematch-${name}.json`, import.meta.url), "utf8")) as T;
const firstMatch = rematch("GET_game_firstMatch");
const firstMatchOver = rematch("GET_game_firstMatchOver");
const betweenMatches = rematch("GET_game_betweenMatches");
const secondMatch = rematch("GET_game_secondMatch");

describe("a second match in the same lobby", () => {
  it("is in the recordings: the same game number and turn, a log that goes on, and another count of games opened", () => {
    expect(firstMatch).toMatchObject({ match: { game: 1 }, turn: 0 });
    expect(betweenMatches).toMatchObject({ inGame: false, gameOver: true, logCount: firstMatchOver.logCount });
    expect(secondMatch).toMatchObject({ match: { game: 1 }, turn: 0, logCount: firstMatchOver.logCount, logStart: firstMatchOver.logCount, messageCount: firstMatchOver.messageCount });
    expect(secondMatch.gamesOpened).toBeGreaterThan(Number(firstMatch.gamesOpened));
  });

  it("starts fresh", async () => {
    const view = seat(rematch<{ log: string[] }>("GET_game_log_secondMatch").log);
    const opening = await view(mainPhase(firstMatch));
    expect(opening).toMatchObject({ cardText: { "Goblin Piker": "Sample rules text" } });
    expect(opening.board).toBeDefined();
    expect((await view(firstMatchOver)).since?.log?.filter(isResult).length).toBeGreaterThan(0);
    await view(betweenMatches);

    // The seat waits on the other player at this opening, so the view has no hand of its own.
    const next = await view(secondMatch);
    expect(next.since?.newInHand).toBeUndefined();
    expect(next.since?.log).toBeUndefined();
    const main = await view(mainPhase(secondMatch));
    expect(main.hand).toHaveLength(7);
    expect(main.board).toBeDefined();
    expect(main.cardText).toEqual(opening.cardText);
    expect(main.since?.newInHand).toBeUndefined();
  });
});
