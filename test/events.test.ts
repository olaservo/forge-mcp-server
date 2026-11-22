import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLog } from "../src/event-log.js";
import { CHAT, ChatTracker, MoveTracker, waitForAsk, YOUR_MOVE } from "../src/seat-events.js";
import { createServer, skillCatalog } from "../src/server.js";
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

  it("stays quiet for the prompts of a seat waiting on its opponent, and wakes it for the next one", () => {
    // Statuses from the fast-agent seat of the game on 2026-11-22, cut down to the fields the tracker reads
    const moves = new MoveTracker(new EventLog());
    const okEndTurn = { ok: "OK", okEnabled: true, cancel: "End Turn", cancelEnabled: true };
    const none = { ok: "OK", okEnabled: false, cancel: "Cancel", cancelEnabled: false };
    const at = (promptCount: number, more: Record<string, unknown>) => ({ revision: promptCount, game: { ...game(promptCount), turn: 7, phase: "MAIN1", priorityPrompt: false, ...more } });
    const waitingFor = { prompt: "Waiting for Claude...", waiting: true, hasPriority: false, buttons: none };
    expect(moves.observe(at(30, waitingFor))).toBeUndefined();
    // The next input's buttons arrive before its prompt and clear `waiting`
    expect(moves.observe(at(30, { ...waitingFor, waiting: false, hasPriority: true, buttons: okEndTurn }))).toBeUndefined();
    // The reveal of a card from the opponent's hand holds the game until the seat presses OK
    const reveal = at(31, { prompt: "Looking at cards in Claude's hand", hasPriority: true, buttons: okEndTurn });
    expect(moves.observe(reveal)?.data).toMatchObject({ kind: "priority", prompt: "Looking at cards in Claude's hand" });
    expect(moves.observe(at(31, waitingFor))).toBeUndefined();
    expect(moves.observe(at(31, { ...waitingFor, waiting: false, buttons: { ...none, okEnabled: true } }))).toBeUndefined();
    const block = "Select creatures to block Archangel (11) or select another attacker to declare blockers for.";
    expect(moves.observe(at(32, { prompt: block, phase: "COMBAT_DECLARE_BLOCKERS", buttons: { ...none, okEnabled: true } }))?.data).toMatchObject({ prompt: block });
    expect(moves.observe(at(32, waitingFor))).toBeUndefined();
    // An optional trigger is a prompt with Yes and No, without a pendingDecision
    const trigger = { prompt: "Use triggered ability of Borderland Ranger?", hasPriority: true, buttons: { ok: "Yes", okEnabled: true, cancel: "No", cancelEnabled: true } };
    expect(moves.observe(at(33, trigger))?.data).toMatchObject({ kind: "priority", prompt: trigger.prompt });
    // Without the wait seen first, the same status is an ask
    expect(new MoveTracker(new EventLog()).observe(at(30, { ...waitingFor, waiting: false, buttons: okEndTurn }))?.data).toMatchObject({ prompt: "Waiting for Claude..." });
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

  it("asks for a deck once the pool arrives, and for a ready flag before the event starts", () => {
    const moves = new MoveTracker(new EventLog());
    const seat = (ready: boolean, phase: string, more = {}) => ({
      mySlot: 1,
      limitedMode: true,
      slots: [{ index: 0, name: "Ola", ready: true }, { index: 1, name: "Agent", ready }],
      event: { eventId: "e1", phase },
      ...more,
    });
    const none = { packNumber: 0, pickPending: false, poolReceived: false };
    // No deck is needed to ready up before a draft, and the ask says so.
    const waiting = moves.observe({ revision: 1, game: { inGame: false }, lobby: seat(false, "LOBBY_GATHER"), draft: none });
    expect(waiting?.data).toMatchObject({ kind: "lobby", prompt: expect.stringContaining("No deck is needed yet") });
    const pick = { packNumber: 1, pickNumber: 1, pickPending: true, poolReceived: false, secondsLeft: 58 };
    expect(moves.observe({ revision: 2, game: { inGame: false }, lobby: seat(true, "DRAFTING"), draft: pick })?.data).toMatchObject({
      kind: "draft_pick",
      prompt: "Pack 1, pick 1, 58 s on the clock",
      secondsLeft: 58,
    });
    // The seat is still ready from before the draft, so the pool itself is the ask.
    const pool = { packNumber: 3, pickNumber: 15, pickPending: false, poolReceived: true, poolEventId: "e1" };
    expect(moves.observe({ revision: 3, game: { inGame: false }, lobby: seat(true, "DRAFTING"), draft: pool })?.data).toMatchObject({ kind: "deck" });
    expect(moves.observe({ revision: 4, game: { inGame: false }, lobby: seat(true, "DRAFTING"), draft: pool })).toBeUndefined();
    const built = seat(true, "DRAFTING", { myDeck: { name: "Draft", mainSize: 40, sideboardSize: 22 } });
    expect(moves.observe({ revision: 5, game: { inGame: false }, lobby: built, draft: pool })).toBeUndefined();
    // The same pool in a later lobby that is not for that event asks for nothing.
    const constructed = { mySlot: 1, limitedMode: false, slots: [{ index: 1, name: "Agent", ready: true }] };
    expect(new MoveTracker(new EventLog()).observe({ revision: 6, game: { inGame: false }, lobby: constructed, draft: pool })).toBeUndefined();
  });

  it("gives the pending ask to a client that polls without a cursor, and to no other client", () => {
    const log = new EventLog();
    const moves = new MoveTracker(log);
    log.onPending(YOUR_MOVE, () => moves.current());
    const seat = { revision: 2, game: { inGame: false }, lobby: { mySlot: 1, slots: [{ index: 0, ready: true }, { index: 1, ready: false }] } };
    const ask = moves.observe(seat)!;
    expect(ask.data).toMatchObject({ kind: "lobby" });
    const follower = log.poll(YOUR_MOVE, log.cursorAfter(ask));
    const first = log.poll(YOUR_MOVE, null);
    expect(first.events).toEqual([ask]);
    expect(first.cursor).toBe(log.head());
    // A second poll without a cursor is the same client opening another subscription, and gets the same eventId
    expect(log.poll(YOUR_MOVE, null).events.map((e) => e.eventId)).toEqual([ask.eventId]);
    // A client that was already following is sent nothing new
    expect(log.poll(YOUR_MOVE, follower.cursor).events).toEqual([]);
    // Once the seat is waiting, nothing is pending
    moves.observe(priority(3, { waiting: true, prompt: "Waiting for Ola..." }));
    expect(log.poll(YOUR_MOVE, null).events).toEqual([]);
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

  it("skips the seat's own lines, renamed or sent from slot 0", () => {
    const chat = new ChatTracker(new EventLog());
    const seat = { connection: { name: "Agent" }, lobby: { mySlot: 0, slots: [{ index: 0, name: "Haiku (Host)" }, { index: 1, name: "Ola" }] } };
    expect(chat.observe({ ...seat, chat: [], chatCount: 0 })).toEqual([]);
    const lines = [{ from: "Haiku (Host)", text: "hello" }, { from: "Agent (Host)", text: "again" }, { from: "Ola", text: "hi" }];
    expect(chat.observe({ ...seat, chat: lines, chatCount: 3 }).map((e) => e.data.from)).toEqual(["Ola"]);
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

  it("ends a stream on notifications/cancelled over a persistent connection, as on stdio", async () => {
    const { bridge } = fakeBridge({});
    const log = new EventLog();
    const server = createServer({ bridge, skills: await skillCatalog(), events: log });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientSide);
    const sent: string[] = [];
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) => {
      if ("method" in message) sent.push(message.method);
      return send(message, options);
    };
    const got: string[] = [];
    client.fallbackNotificationHandler = async (n) => void got.push(n.method);
    const listeners = () => (log as unknown as { listeners: unknown[] }).listeners.length;

    const abort = new AbortController();
    const done = client.request({ method: "events/stream", params: { name: YOUR_MOVE, cursor: null } }, z.looseObject({}), { signal: abort.signal, timeout: 60_000 });
    done.catch(() => {});
    await vi.waitFor(() => expect(got).toEqual(["notifications/events/active"]));
    expect(listeners()).toBe(1);

    abort.abort();
    await expect(done).rejects.toThrow();
    expect(sent).toContain("notifications/cancelled");
    await vi.waitFor(() => expect(listeners()).toBe(0));
    log.emit(YOUR_MOVE, { kind: "priority" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toEqual(["notifications/events/active"]);
    await client.close();
  });

  it("marks a cursor older than the retained window as truncated", () => {
    const log = new EventLog(2);
    const { cursor } = log.poll(YOUR_MOVE, null);
    for (let i = 0; i < 4; i++) log.emit(YOUR_MOVE, { i });
    expect(log.poll(YOUR_MOVE, cursor)).toMatchObject({ events: [], truncated: true });
  });
});

describe("waitForAsk", () => {
  /** A bridge whose /wait answers with the next status in `seq`, or the last one once they run out. */
  const bridge = (now: object, seq: object[]) => {
    const calls: number[] = [];
    const wait = async (since: number) => {
      calls.push(since);
      return (since < 0 ? now : (seq.shift() ?? { ...now })) as never;
    };
    return { wait, calls };
  };
  const theirs = (revision: number) => ({ revision, chatCount: 0, game: game(5, { prompt: "Waiting for Opponent...", waiting: true, buttons: {} }) });

  it("returns at once for since -1", async () => {
    const { wait, calls } = bridge(priority(4), []);
    expect((await waitForAsk(wait, -1, 5)).revision).toBe(4);
    expect(calls).toEqual([-1]);
  });

  it("skips changes that ask nothing of the seat and returns at the next prompt", async () => {
    const { wait, calls } = bridge(theirs(4), [theirs(5), theirs(6), { ...priority(6), revision: 7 }]);
    const status = await waitForAsk(wait, 4, 5);
    expect(status.revision).toBe(7);
    expect(calls).toEqual([-1, 4, 5, 6]);
  });

  it("returns a pending ask newer than since without waiting", async () => {
    const { wait, calls } = bridge({ ...priority(6), revision: 9 }, []);
    expect((await waitForAsk(wait, 4, 5)).revision).toBe(9);
    expect(calls).toEqual([-1]);
  });

  it("returns on another player's chat line, not on the seat's own", async () => {
    const me = { connection: { name: "Agent" } };
    const said = (revision: number, from: string) => ({ ...theirs(revision), ...me, chatCount: 1, chat: [{ from, text: "hi" }] });
    const { wait } = bridge({ ...theirs(4), ...me }, [said(5, "Agent"), { ...said(6, "Agent"), chatCount: 2, chat: [{ from: "Agent", text: "hi" }, { from: "Opponent", text: "gl" }] }]);
    expect((await waitForAsk(wait, 4, 5)).revision).toBe(6);
  });

  it("returns when the bridge times out with no change", async () => {
    const { wait } = bridge(theirs(4), [theirs(4)]);
    expect((await waitForAsk(wait, 4, 5)).revision).toBe(4);
  });
});
