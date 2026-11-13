import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHAT, ChatTracker, EventLog, MoveTracker, YOUR_MOVE, type PollResult } from "../src/events.js";
import { connect, fakeBridge } from "./helpers.js";

const priority = (prompt: string, revision: number) => ({
  revision,
  game: { inGame: true, prompt, turn: 3, phase: "MAIN1", buttons: { okEnabled: true, cancelEnabled: false } },
});

describe("events", () => {
  it("emits forge.your_move once per new ask and not while waiting", () => {
    const moves = new MoveTracker(new EventLog());
    expect(moves.observe({ revision: 1, game: { inGame: true, prompt: "Waiting for HostAI...", buttons: { okEnabled: true } } })).toBeUndefined();
    const yielding = "Yielding until end of turn.\nYou may cancel this yield to take an action.\n\nWaiting for HostAI...";
    expect(moves.observe({ revision: 1, game: { inGame: true, prompt: yielding, buttons: { cancelEnabled: true } } })).toBeUndefined();
    expect(moves.observe(priority("", 1))).toBeUndefined();
    const upkeep = { inGame: true, turn: 3, prompt: "Priority: Agent / Phase: Upkeep step", buttons: { okEnabled: true } };
    expect(moves.observe({ revision: 1, game: { ...upkeep, phase: "UPKEEP" } })?.data).toMatchObject({ kind: "priority" });
    expect(moves.observe({ revision: 1, game: { ...upkeep, phase: "DRAW" } })).toBeUndefined();
    const stale = { revision: 1, game: { inGame: true, prompt: "Priority: Agent" + String.fromCharCode(10) + "Phase: Upkeep step", hasPriority: false, buttons: { okEnabled: true } } };
    expect(moves.observe(stale)).toBeUndefined();
    expect(moves.observe(priority("Priority: Agent", 2))?.data).toMatchObject({ kind: "priority", revision: 2 });
    expect(moves.observe(priority("Priority: Agent", 3))).toBeUndefined();
    const decision = { revision: 4, game: { inGame: true, pendingDecision: { id: 7, kind: "choices", prompt: "Mulligan?" } } };
    expect(moves.observe(decision)?.data).toMatchObject({ kind: "decision", prompt: "Mulligan?" });
    expect(moves.observe({ revision: 5, game: { inGame: true, prompt: "Waiting for HostAI..." } })).toBeUndefined();
    expect(moves.observe(priority("Priority: Agent", 6))?.data).toMatchObject({ revision: 6 });
    const pick = { revision: 7, game: { inGame: false }, draft: { pickPending: true, packNumber: 1, pickNumber: 2 } };
    expect(moves.observe(pick)?.data).toMatchObject({ kind: "draft_pick" });
  });

  it("emits game_over once when the seat is already back in the lobby", () => {
    const moves = new MoveTracker(new EventLog());
    const over = { revision: 9, game: { inGame: false, finished: true, gameOver: true, winner: "Agent", turn: 14 } };
    expect(moves.observe(priority("Priority: Agent", 8))?.data).toMatchObject({ kind: "priority" });
    expect(moves.observe(over)?.data).toMatchObject({ kind: "game_over", prompt: "Game over. Winner: Agent" });
    expect(moves.observe({ ...over, revision: 10 })).toBeUndefined();
    const pick = { ...over, revision: 11, draft: { pickPending: true, packNumber: 1, pickNumber: 1 } };
    expect(moves.observe(pick)?.data).toMatchObject({ kind: "draft_pick" });
    expect(moves.observe({ ...over, revision: 12 })).toBeUndefined();
  });

  it("emits game_over again when a later game ends the same way", () => {
    const moves = new MoveTracker(new EventLog());
    const over = { revision: 9, game: { inGame: false, finished: true, gameOver: true, winner: "Agent", turn: 12 } };
    expect(moves.observe(over)?.data).toMatchObject({ kind: "game_over" });
    expect(moves.observe({ ...over, revision: 10 })).toBeUndefined();
    expect(moves.observe(priority("Priority: Agent", 11))?.data).toMatchObject({ kind: "priority" });
    expect(moves.observe({ ...over, revision: 20 })?.data).toMatchObject({ kind: "game_over", revision: 20 });
    expect(moves.observe({ ...over, revision: 21 })).toBeUndefined();
  });

  it("emits forge.chat for new lines from other players only", () => {
    const chat = new ChatTracker(new EventLog());
    const seat = { connection: { name: "Claude" }, lobby: { slots: [{ name: "Ola" }, { name: "Claude" }] } };
    const old = ["Claude joined the lobby.", "AFK timeout: 5:00", "Ola: before we were watching"];
    expect(chat.observe({ ...seat, chat: old })).toEqual([]);
    expect(chat.observe({ ...seat, chat: old })).toEqual([]);
    const next = chat.observe({ ...seat, revision: 9, chat: [...old, "Claude: hi", "Ola: do you see this?", "AFK timeout: 4:00"] });
    expect(next.map((e) => e.data)).toEqual([{ from: "Ola", text: "do you see this?", revision: 9 }]);
    const full = Array.from({ length: 20 }, (_, i) => `Ola: line ${i}`);
    chat.observe({ ...seat, chat: full });
    expect(chat.observe({ ...seat, chat: [...full.slice(2), "Ola: one", "Ola: two"] }).map((e) => e.data.text)).toEqual(["one", "two"]);
  });

  it("serves events/list and events/poll with cursors", async () => {
    const { bridge } = fakeBridge({});
    const log = new EventLog();
    const client = await connect(bridge, undefined, log);
    const Any = z.looseObject({});

    const listed = (await client.request({ method: "events/list", params: {} }, Any)) as { events: { name: string; delivery: string[] }[] };
    expect(listed.events.map((e) => [e.name, e.delivery])).toEqual([[YOUR_MOVE, ["poll"]], [CHAT, ["poll"]]]);

    const poll = (cursor: string | null) =>
      client.request({ method: "events/poll", params: { name: YOUR_MOVE, arguments: {}, cursor } }, Any) as Promise<PollResult>;
    const start = await poll(null);
    expect(start).toMatchObject({ events: [], truncated: false, hasMore: false });

    log.emit(YOUR_MOVE, { kind: "priority" });
    const next = await poll(start.cursor);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({ name: YOUR_MOVE, data: { kind: "priority" } });
    expect((await poll(next.cursor)).events).toEqual([]);

    expect(await poll("otherproc:4")).toMatchObject({ events: [], truncated: true });
    await expect(client.request({ method: "events/poll", params: { name: "nope", cursor: null } }, Any)).rejects.toMatchObject({ code: -32023 });
    await client.close();
  });

  it("marks a cursor older than the retained window as truncated", () => {
    const log = new EventLog(2);
    const { cursor } = log.poll(YOUR_MOVE, null);
    for (let i = 0; i < 4; i++) log.emit(YOUR_MOVE, { i });
    expect(log.poll(YOUR_MOVE, cursor)).toMatchObject({ events: [], truncated: true });
  });
});
