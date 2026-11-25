import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import { MoveTracker, type SeatStatus } from "../src/seat-events.js";
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
    expect(res.structuredContent).toMatchObject({ prompt: expect.stringContaining("play or draw") });
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
