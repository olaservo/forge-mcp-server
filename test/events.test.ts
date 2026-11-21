import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLog } from "../src/event-log.js";
import { CHAT, ChatTracker, MoveTracker, YOUR_MOVE } from "../src/seat-events.js";
import { connect, fakeBridge } from "./helpers.js";

const game = (promptCount: number, more = {}) => ({
  inGame: true,
  prompt: "Priority: Agent",
  promptCount,
  waiting: false,
  turn: 3,
  phase: "MAIN1",
  buttons: { okEnabled: true, cancelEnabled: false },
  ...more,
});
const priority = (promptCount: number, more = {}) => ({ revision: promptCount, game: game(promptCount, more) });

describe("events", () => {
  it("emits forge.your_move once per new ask and not while waiting", () => {
    const moves = new MoveTracker(new EventLog());
    const waiting = { waiting: true, prompt: "Waiting for HostAI..." };
    expect(moves.observe(priority(1, waiting))).toBeUndefined();
    const yielding = "Yielding until end of turn.\nYou may cancel this yield to take an action.\n\nWaiting for HostAI...";
    expect(moves.observe(priority(1, { waiting: true, prompt: yielding, buttons: { cancelEnabled: true } }))).toBeUndefined();
    expect(moves.observe(priority(1, { prompt: "" }))).toBeUndefined();
    expect(moves.observe(priority(2, { phase: "UPKEEP" }))?.data).toMatchObject({ kind: "priority", revision: 2 });
    expect(moves.observe(priority(2, { phase: "DRAW" }))).toBeUndefined();
    // The host passed for the seat and left the prompt up.
    expect(moves.observe(priority(2, { hasPriority: false }))).toBeUndefined();
    // The same text again is a new ask: priority came back after the seat played a land.
    expect(moves.observe(priority(3))?.data).toMatchObject({ kind: "priority", revision: 3 });
    expect(moves.observe(priority(3))).toBeUndefined();
    const decision = { revision: 4, game: game(3, { pendingDecision: { id: 7, kind: "choices", prompt: "Mulligan?" } }) };
    expect(moves.observe(decision)?.data).toMatchObject({ kind: "decision", prompt: "Mulligan?" });
    expect(moves.observe(priority(5, waiting))).toBeUndefined();
    // The flag decides, whatever the text says or the language Forge runs in.
    expect(moves.observe(priority(6, { prompt: "Waiting for the stack" }))?.data).toMatchObject({ revision: 6 });
    expect(moves.observe(priority(6, { waiting: true, prompt: "En attente de HostAI..." }))).toBeUndefined();
    // The bridge's mark is believed over the text.
    expect(moves.observe(priority(7, { prompt: "Priorité: Agent", priorityPrompt: true, hasPriority: false }))).toBeUndefined();
    expect(moves.observe(priority(8, { priorityPrompt: false, hasPriority: false }))?.data).toMatchObject({ revision: 8 });
    const pick = { revision: 7, game: { inGame: false }, draft: { pickPending: true, packNumber: 1, pickNumber: 2 } };
    expect(moves.observe(pick)?.data).toMatchObject({ kind: "draft_pick" });
  });

  it("emits a lobby ask once while the seat sits unready", () => {
    const moves = new MoveTracker(new EventLog());
    const lobby = (ready: boolean, name = "Agent") => ({
      revision: 2,
      game: { inGame: false },
      lobby: { mySlot: 1, slots: [{ index: 0, name: "Ola", ready: true }, { index: 1, name, ready }] },
    });
    expect(moves.observe({ revision: 1, game: { inGame: false }, lobby: { mySlot: -1 } })).toBeUndefined();
    expect(moves.observe(lobby(false))?.data).toMatchObject({ kind: "lobby" });
    expect(moves.observe(lobby(false, "Sarge"))).toBeUndefined();
    expect(moves.observe(lobby(true, "Sarge"))).toBeUndefined();
    expect(moves.observe(lobby(false, "Sarge"))?.data).toMatchObject({ kind: "lobby" });
    const drafting = { ...lobby(false), draft: { packNumber: 1, pickNumber: 3, pickPending: false, poolReceived: false } };
    expect(new MoveTracker(new EventLog()).observe(drafting)).toBeUndefined();
  });

  it("replays the pending ask to a client that polls without a cursor", async () => {
    const log = new EventLog();
    const moves = new MoveTracker(log);
    const seat = { revision: 2, game: { inGame: false }, lobby: { mySlot: 1, slots: [{ index: 0, ready: true }, { index: 1, ready: false }] } };
    log.onFirstPoll((name) => name === YOUR_MOVE && moves.replay(seat));
    expect(moves.observe(seat)?.data).toMatchObject({ kind: "lobby" });
    const first = log.poll(YOUR_MOVE, null);
    expect(first.events).toEqual([]);
    await Promise.resolve();
    expect(log.poll(YOUR_MOVE, first.cursor).events.map((e) => e.data.kind)).toEqual(["lobby"]);
    // A second poll without a cursor a moment later is the same client opening another subscription
    const second = log.poll(YOUR_MOVE, null);
    await Promise.resolve();
    expect(log.poll(YOUR_MOVE, second.cursor).events).toEqual([]);
    expect(moves.replay(seat, 0)?.data).toMatchObject({ kind: "lobby" });
    expect(moves.observe(seat)).toBeUndefined();
    expect(moves.replay(priority(3, { waiting: true, prompt: "Waiting for Ola..." }))).toBeUndefined();
  });

  it("emits game_over once when the seat is already back in the lobby", () => {
    const moves = new MoveTracker(new EventLog());
    const over = { revision: 9, game: { inGame: false, finished: true, gameOver: true, winner: "Agent", turn: 14 } };
    expect(moves.observe(priority(8))?.data).toMatchObject({ kind: "priority" });
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
    expect(moves.observe(priority(11))?.data).toMatchObject({ kind: "priority" });
    expect(moves.observe({ ...over, revision: 20 })?.data).toMatchObject({ kind: "game_over", revision: 20 });
    expect(moves.observe({ ...over, revision: 21 })).toBeUndefined();
  });

  it("emits forge.chat for new lines from other players only", () => {
    const chat = new ChatTracker(new EventLog());
    const seat = { connection: { name: "Claude" } };
    const host = (text: string) => ({ from: null, text });
    const old = [host("Claude joined the lobby."), { from: "Ola", text: "before we were watching" }];
    expect(chat.observe({ ...seat, chat: old, chatCount: 2 })).toEqual([]);
    expect(chat.observe({ ...seat, chat: old, chatCount: 2 })).toEqual([]);
    // A name or a line with ": " in it is not split, and a player who is not in a lobby slot is still heard.
    const lines = [{ from: "Claude", text: "hi" }, { from: "Ola: the host", text: "re: your block" }, host("AFK timeout: 4:00")];
    const next = chat.observe({ ...seat, revision: 9, chat: [...old, ...lines], chatCount: 5 });
    expect(next.map((e) => e.data)).toEqual([{ from: "Ola: the host", text: "re: your block", revision: 9 }]);
    // Twenty identical lines: only the count says two more arrived.
    const same = Array.from({ length: 20 }, () => ({ from: "Ola", text: "gg" }));
    expect(chat.observe({ ...seat, chat: same, chatCount: 30 }).length).toBe(20);
    expect(chat.observe({ ...seat, chat: same, chatCount: 30 })).toEqual([]);
    expect(chat.observe({ ...seat, chat: same, chatCount: 32 }).map((e) => e.data.text)).toEqual(["gg", "gg"]);
  });

  it("reads the chat lines of bridge 0.1.4, which are text", () => {
    const chat = new ChatTracker(new EventLog());
    const seat = { connection: { name: "Claude" }, lobby: { slots: [{ name: "Ola" }, { name: "Claude" }] } };
    const old = ["Claude joined the lobby.", "AFK timeout: 5:00", "Ola: before we were watching"];
    expect(chat.observe({ ...seat, chat: old, chatCount: 3 })).toEqual([]);
    expect(chat.observe({ ...seat, chat: old, chatCount: 3 })).toEqual([]);
    const next = chat.observe({ ...seat, revision: 9, chat: [...old, "Claude: hi", "Ola: do you see this?", "AFK timeout: 4:00"], chatCount: 6 });
    expect(next.map((e) => e.data)).toEqual([{ from: "Ola", text: "do you see this?", revision: 9 }]);
  });

  it("serves events/list and events/poll with cursors", async () => {
    const { bridge } = fakeBridge({});
    const log = new EventLog();
    const client = await connect(bridge, undefined, log);
    const Any = z.looseObject({});

    const listed = (await client.request({ method: "events/list", params: {} }, Any)) as { events: { name: string; delivery: string[] }[] };
    expect(listed.events.map((e) => [e.name, e.delivery])).toEqual([[YOUR_MOVE, ["poll", "push"]], [CHAT, ["poll", "push"]]]);

    const Polled = z.looseObject({ events: z.array(z.looseObject({})), cursor: z.string(), truncated: z.boolean(), hasMore: z.boolean() });
    const poll = (cursor: string | null) => client.request({ method: "events/poll", params: { name: YOUR_MOVE, arguments: {}, cursor } }, Polled);
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

  it("pushes events on events/stream until the client aborts", async () => {
    const { bridge } = fakeBridge({});
    const log = new EventLog();
    const client = await connect(bridge, undefined, log);
    const got: { method: string; params?: Record<string, unknown> }[] = [];
    client.fallbackNotificationHandler = async (n) => void got.push(n);
    const Any = z.looseObject({});
    const listeners = () => (log as unknown as { listeners: unknown[] }).listeners.length;
    const open = (params: Record<string, unknown>) => {
      const abort = new AbortController();
      const done = client.request({ method: "events/stream", params: { name: YOUR_MOVE, ...params } }, Any, { signal: abort.signal, timeout: 60_000 });
      done.catch(() => {});
      return { abort, done };
    };
    const methods = () => got.map((n) => n.method);

    const first = open({ cursor: null, heartbeatMs: 1 });
    await vi.waitFor(() => expect(methods()).toEqual(["notifications/events/active"]));
    const active = got[0]!.params!;
    expect(active).toMatchObject({ truncated: false, heartbeatMs: 1000 });
    const subscription = (active._meta as Record<string, unknown>)["io.modelcontextprotocol/subscriptionId"];
    expect(subscription).toBeDefined();

    log.emit(CHAT, { from: "Ola", text: "hi" });
    const move = log.emit(YOUR_MOVE, { kind: "priority" });
    await vi.waitFor(() => expect(methods()).toHaveLength(2));
    expect(got[1]).toMatchObject({
      method: "notifications/events/event",
      params: { eventId: move.eventId, name: YOUR_MOVE, data: { kind: "priority" }, cursor: log.cursorAfter(move), _meta: { "io.modelcontextprotocol/subscriptionId": subscription } },
    });
    await vi.waitFor(() => expect(methods()[2]).toBe("notifications/events/heartbeat"), { timeout: 3000 });
    expect(got[2]!.params).toMatchObject({ cursor: log.head() });

    first.abort.abort();
    await expect(first.done).rejects.toThrow();
    await vi.waitFor(() => expect(listeners()).toBe(0));

    // A stream that resumes from a cursor gets what it missed first.
    const missed = log.emit(YOUR_MOVE, { kind: "decision" });
    got.length = 0;
    const second = open({ cursor: log.cursorAfter(move) });
    await vi.waitFor(() => expect(methods()).toEqual(["notifications/events/active", "notifications/events/event"]));
    expect(got[0]!.params).toMatchObject({ cursor: log.cursorAfter(move), truncated: false });
    expect(got[1]!.params).toMatchObject({ eventId: missed.eventId, cursor: log.cursorAfter(missed) });
    second.abort.abort();
    await expect(second.done).rejects.toThrow();

    await expect(client.request({ method: "events/stream", params: { name: "nope" } }, Any)).rejects.toMatchObject({ code: -32023 });
    await client.close();
  });

  it("marks a cursor older than the retained window as truncated", () => {
    const log = new EventLog(2);
    const { cursor } = log.poll(YOUR_MOVE, null);
    for (let i = 0; i < 4; i++) log.emit(YOUR_MOVE, { i });
    expect(log.poll(YOUR_MOVE, cursor)).toMatchObject({ events: [], truncated: true });
  });
});
