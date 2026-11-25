import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.js";
import { afterPick, draftFor, DraftMemory, manaValue, tally } from "../src/draft.js";
import { EventLog, type EventOccurrence } from "../src/event-log.js";
import { createSeat } from "../src/seat.js";
import { MoveTracker } from "../src/seat-events.js";
import { memoryFor } from "../src/view.js";
import { connect, fakeBridge } from "./helpers.js";

type Json = Record<string, unknown>;
type Card = { name: string; type?: string; text?: string; count?: number; rarity?: string };

/** Recorded by forge-agent-bridge's AgentDraftTest on 0.1.10: pack 3 pick 1 of a two-seat M11 draft, and the pool it ended with. */
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Json;
const pack = fixture("draft-GET_draft_pack.json");
const pool = fixture("draft-GET_draft_pool.json");
/** The same ask from the bridge that names its packs: `at` is "3:1". */
const named = fixture("draft-GET_draft_pack_at.json");
const packCards = pack.pack as Json[];
const names = (cards: unknown) => (cards as Card[]).map((c) => c.name);
/** A creature with no abilities has no rules text to send. */
const withText = (cards: Json[]) => [...new Set(cards.filter((c) => c.oracle).map((c) => String(c.name)))].sort();
const PACK_TEXTS = withText(packCards).length;

describe("the pack view", () => {
  it("shows each card without its printing and sends rules text once per card name", () => {
    const drafts = new DraftMemory();
    const view = drafts.pack(pack, { commit: true });
    // An older bridge does not name the pack, so the view does.
    expect(pack).not.toHaveProperty("at");
    expect(view).toMatchObject({ at: "3:1", packNumber: 3, pickNumber: 1, secondsLeft: 120 });
    expect(new DraftMemory().pack({ ...named, at: "3:1b" }, { commit: true }).at).toBe("3:1b");
    expect(names(view.pack)).toEqual(packCards.map((c) => c.name));
    const angel = (view.pack as Json[]).find((c) => c.name === "Serra Angel");
    expect(angel).toEqual({ name: "Serra Angel", manaCost: "{3}{W}{W}", type: "Creature - Angel", pt: "4/4", rarity: "Uncommon" });
    // A land has no cost to show, and a common's rarity is left out.
    expect((view.pack as Json[]).find((c) => c.name === "Plains")).toEqual({ name: "Plains", type: "Basic Land - Plains" });
    expect(Object.keys(view.cardText as Json).sort()).toEqual(withText(packCards));
    expect(PACK_TEXTS).toBe(13);
    expect(view.cardText).not.toHaveProperty("Spined Wurm");
    expect((view.cardText as Json)["Serra Angel"]).toContain("Flying");
    // Forge's scripts write a line break as the characters `\n`.
    expect(JSON.stringify(view.cardText)).not.toContain("\\\\n");
    // The same pack one card shorter, as it comes round the table: nothing is repeated.
    const again = drafts.pack({ ...pack, pickNumber: 3, pack: packCards.slice(2) }, { commit: true });
    expect(again.pack).toHaveLength(13);
    expect(again.cardText).toBeUndefined();
    expect(Object.keys(drafts.pack(pack, { commit: true, allText: true }).cardText as Json)).toHaveLength(PACK_TEXTS);
  });

  it("counts the picks by colour, kind and mana value, and the ones it never saw", () => {
    const drafts = new DraftMemory();
    // Picks from packs this memory was never shown.
    expect(drafts.pack({ ...pack, picks: ["Nether Horror", "Duress"] }, { commit: true }).drafted).toEqual({ count: 2, colors: {}, creatures: 0, other: 0, unknown: 2, curve: {} });
    const picks = ["Serra Angel", "Cancel", "Spined Wurm", "Plains", "Kraken's Eye"];
    const view = new DraftMemory().pack({ ...pack, picks, autoPicks: ["Plains (pack 3 pick 1)"] }, { commit: true });
    expect(view.drafted).toEqual({ count: 5, colors: { W: 1, U: 1, G: 1, colorless: 1 }, creatures: 2, other: 2, lands: 1, curve: { "2": 1, "3": 1, "5": 2 } });
    expect(view.autoPicks).toEqual(["Plains (pack 3 pick 1)"]);
    expect(new DraftMemory().pack({ ...pack, picks: [] }, { commit: true }).drafted).toBeUndefined();
  });

  it("says how many packs wait behind the one shown", () => {
    // In the recording the host seat had already picked from its first pack of the round and passed it on.
    // The seat's own count includes the pack in front of it.
    expect(pack).toMatchObject({ seatIndex: 1, seatQueueDepths: [0, 2] });
    expect(new DraftMemory().pack(pack, { commit: true }).queued).toBe(1);
    expect(new DraftMemory().pack({ ...pack, seatQueueDepths: [0, 0] }, { commit: true })).not.toHaveProperty("queued");
    expect(new DraftMemory().pack({ ...pack, seatQueueDepths: [0, 1] }, { commit: true })).not.toHaveProperty("queued");
    expect(new DraftMemory().pack({ ...pack, seatQueueDepths: [0, 3] }, { commit: true }).queued).toBe(2);
    expect(new DraftMemory().pack({ ...pack, pickPending: false, seatQueueDepths: [0, 3], picks: [] }, { commit: true })).toEqual({ waiting: true });
  });

  it("reads a cost's mana value", () => {
    expect([manaValue("{3}{W}{W}"), manaValue("{X}{R}"), manaValue("{2/W}{W/U}"), manaValue("no cost"), manaValue(null)]).toEqual([5, 1, 3, 0, 0]);
    expect(tally([{ type: "Creature - Wurm", colors: "G", manaCost: "{6}{G}" }]).curve).toEqual({ "6+": 1 });
  });

  it("says when no pack is waiting and when the draft is over, without the old pack", () => {
    const drafts = new DraftMemory();
    expect(drafts.pack({ ...pack, pickPending: false, picks: [] }, { commit: true })).toEqual({ waiting: true });
    expect(drafts.pack({ ...pack, pickPending: false, poolReceived: true, picks: [] }, { commit: true })).toEqual({ poolReceived: true });
  });

  it("keeps an event's text unsent until a pick names its pack", () => {
    const drafts = new DraftMemory();
    // The event may never reach the model, so a tool result sends the text again.
    expect(Object.keys(drafts.pack(pack, { commit: false }).cardText as Json)).toHaveLength(PACK_TEXTS);
    expect(Object.keys(drafts.pack(pack, { commit: true }).cardText as Json)).toHaveLength(PACK_TEXTS);
    expect(Object.keys(new DraftMemory().pack(pack, { commit: false }).cardText as Json)).toHaveLength(PACK_TEXTS);
    const read = new DraftMemory();
    read.pack(pack, { commit: false });
    expect(Object.keys(read.pack({ ...pack, pickNumber: 2, pack: packCards.slice(1) }, { commit: false }).cardText as Json)).toHaveLength(PACK_TEXTS);
    read.saw("pack:3:1");
    expect(read.pack({ ...pack, pickNumber: 2, pack: packCards.slice(1) }, { commit: true }).cardText).toBeUndefined();
  });

  it("starts again when the pick list does", () => {
    const drafts = new DraftMemory();
    drafts.pack(pack, { commit: true });
    expect(Object.keys(drafts.pack({ ...pack, packNumber: 1, picks: [] }, { commit: true }).cardText as Json)).toHaveLength(PACK_TEXTS);
  });
});

describe("the pool view", () => {
  it("has one entry per card name with counts, sorted by colour and cost", () => {
    const view = new DraftMemory().pool(pool, { commit: true });
    expect(view).toMatchObject({ poolReceived: true, eventId: pool.eventId, landSet: "M11", size: 45 });
    const cards = view.cards as Card[];
    expect(cards).toHaveLength(39);
    expect(cards.reduce((sum, c) => sum + (c.count ?? 0), 0)).toBe(45);
    expect(cards.find((c) => c.name === "Volcanic Strength")?.count).toBe(2);
    // White first, lands last.
    expect(cards[0].type).not.toContain("Land");
    expect(cards.at(-1)).toMatchObject({ name: "Plains", count: 2 });
    const counts = view.counts as { count: number; creatures: number; other: number; lands: number; colors: Record<string, number>; curve: Record<string, number> };
    expect(counts.count).toBe(45);
    expect(counts.creatures + counts.other + counts.lands).toBe(45);
    expect(counts.colors).toMatchObject({ W: 7, U: 10, B: 8, R: 7, G: 8 });
    expect(Object.values(counts.curve).reduce((a, b) => a + b, 0)).toBe(43);
    expect(view).not.toHaveProperty("path");
    expect(new DraftMemory().pool({ poolReceived: false }, { commit: true })).toEqual({ poolReceived: false });
  });

  it("sends text only for names the draft did not send, and all of it to a sealed seat", () => {
    const drafts = new DraftMemory();
    drafts.pack(pack, { commit: true });
    const inPack = new Set(packCards.map((c) => c.name));
    const view = drafts.pool(pool, { commit: true });
    const sent = Object.keys(view.cardText as Json);
    expect(sent.some((name) => inPack.has(name))).toBe(false);
    expect(sent.length).toBeGreaterThan(0);
    expect(drafts.pool(pool, { commit: true }).cardText).toBeUndefined();
    // A pool for another event with no pack in between is a sealed pool: nothing of it was sent.
    expect(Object.keys(drafts.pool({ ...pool, eventId: "sealed1" }, { commit: true }).cardText as Json).sort()).toEqual(withText(pool.cards as Json[]));
  });
});

/** A bridge whose draft moves on with each pick: `after` is the draft block once the pick is made. */
function draftingBridge(after: Json, more: Record<string, unknown> = {}) {
  let picked = false;
  const before = { ...pack, picks: [] };
  const draft = () => (picked ? after : { ...before, pack: undefined });
  return fakeBridge({
    get "POST /draft/pick"() {
      picked = true;
      return { picked: packCards[0], packNumber: 3, pickNumber: 1 };
    },
    get "GET /wait"() {
      return { revision: picked ? 8 : 7, draft: draft() };
    },
    get "GET /draft/pack"() {
      return picked ? after : before;
    },
    ...more,
  });
}

describe("forge_draft_pick", () => {
  const next = { ...pack, pickNumber: 2, secondsLeft: 119, pack: packCards.slice(1), picks: ["Spined Wurm"] };

  it("answers with the next pack when it is already there", async () => {
    const { bridge, calls } = draftingBridge(next);
    const client = await connect(bridge);
    const shown = (await client.callTool({ name: "forge_draft_pack", arguments: {} })).structuredContent as Json;
    expect(Object.keys(shown.cardText as Json)).toHaveLength(PACK_TEXTS);
    const res = await client.callTool({ name: "forge_draft_pick", arguments: { card: "Spined Wurm" } });
    expect(res.isError).toBeFalsy();
    const answer = res.structuredContent as Json;
    expect(answer.picked).toEqual({ name: "Spined Wurm", packNumber: 3, pickNumber: 1 });
    expect(answer).toMatchObject({ packNumber: 3, pickNumber: 2, secondsLeft: 119, drafted: { count: 1, colors: { G: 1 }, creatures: 1 } });
    expect(names(answer.pack)).toEqual(packCards.slice(1).map((c) => c.name));
    // Every card of it was in the pack just shown.
    expect(answer.cardText).toBeUndefined();
    expect(calls.find((c) => c.path === "/draft/pick")?.body).toEqual({ card: "Spined Wurm" });
    await client.close();
  });

  it("says it is waiting when no pack comes, and does not show the old one", async () => {
    // No view of the pack went through this server, so it cannot count the card.
    const { bridge } = draftingBridge({ ...pack, pickPending: false, secondsLeft: undefined, pack: undefined, picks: ["Spined Wurm"] });
    const client = await connect(bridge);
    const answer = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0" } })).structuredContent as Json;
    expect(answer).toEqual({ picked: { name: "Spined Wurm", packNumber: 3, pickNumber: 1 }, waiting: true, drafted: { count: 1, colors: {}, creatures: 0, other: 0, unknown: 1, curve: {} } });
    await client.close();
  });

  it("answers the last pick with the pool when it has arrived", async () => {
    const over = { ...pack, pickPending: false, poolReceived: true, pack: undefined, picks: [] };
    const { bridge } = draftingBridge(over, { "GET /draft/pool": pool });
    const client = await connect(bridge);
    const answer = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0" } })).structuredContent as Json;
    expect(answer).toMatchObject({ picked: { name: "Spined Wurm" }, poolReceived: true, pool: { size: 45, counts: { count: 45 } } });
    expect(answer.pack).toBeUndefined();
    await client.close();
  });

  it("still confirms the pick when what comes next cannot be read", async () => {
    const { bridge } = fakeBridge({ "POST /draft/pick": { picked: { name: "Lightning Bolt" }, packNumber: 1, pickNumber: 1 } });
    const client = await connect(bridge);
    const res = await client.callTool({ name: "forge_draft_pick", arguments: { card: "Lightning Bolt" } });
    expect(res.structuredContent).toEqual({ picked: { name: "Lightning Bolt", packNumber: 1, pickNumber: 1 } });
    await client.close();
  });

  it("stops holding when the bridge's own wait runs out", async () => {
    const idle = { revision: 5, draft: { pickPending: false, poolReceived: false } };
    const { bridge, calls } = fakeBridge({ "GET /wait": idle });
    expect(await afterPick(bridge, 60_000)).toEqual(idle.draft);
    expect(calls).toHaveLength(2);
  });
});

describe("forge_draft_pick with at", () => {
  const idle = { revision: 5, draft: { pickPending: false, poolReceived: false, at: null, picks: ["Shock"] } };
  const made = { picked: { name: "Shock" }, packNumber: 3, pickNumber: 1 };
  const posted = (calls: { path: string; body?: unknown }[]) => calls.filter((c) => c.path === "/draft/pick").map((c) => c.body);

  it("names the pack to the bridge, and a stale pick answers with the pack waiting now", async () => {
    expect(named.at).toBe("3:1");
    const later = { ...named, at: "3:2", pickNumber: 2 };
    const { bridge, calls } = fakeBridge({ "GET /draft/pack": later, "POST /draft/pick": fixture("draft-POST_draft_pick_stale.json"), "GET /wait": idle });
    const client = await connect(bridge);
    const answer = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0", at: "3:1" } })).structuredContent as Json;
    expect(posted(calls)).toEqual([{ card: "0", at: "3:1" }]);
    expect(answer).toMatchObject({ stale: true, at: "3:2", pickNumber: 2 });
    expect(answer.pack).toHaveLength(15);
    expect(answer.picked).toBeUndefined();
    // Nothing was picked, so there is no next pack to hold for.
    expect(calls.some((c) => c.path === "/wait")).toBe(false);
    const bad = await client.callTool({ name: "forge_draft_pick", arguments: { card: "0", at: "2.7" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("takes a pick that names a pack as proof the seat read that pack's event", async () => {
    // The pick is refused, and the pack it named is still the one waiting: its text is not sent again.
    const { bridge } = fakeBridge({ "GET /draft/pack": named, "POST /draft/pick": { stale: true, at: "3:1" } });
    const client = await connect(bridge);
    expect(draftFor(bridge).pack(named, { commit: false }).cardText).toBeDefined();
    const answer = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0", at: "3:1" } })).structuredContent as Json;
    expect(answer).toMatchObject({ stale: true, at: "3:1" });
    expect(answer.cardText).toBeUndefined();
    await client.close();
  });

  it("names the pack it last showed when at is left out, and none once an event has reported a later pack", async () => {
    const { bridge, calls } = fakeBridge({ "GET /draft/pack": named, "POST /draft/pick": made, "GET /wait": idle });
    const client = await connect(bridge);
    // Nothing shown yet: the pick is made from whatever pack is waiting.
    await client.callTool({ name: "forge_draft_pick", arguments: { card: "0" } });
    await client.callTool({ name: "forge_draft_pack", arguments: {} });
    await client.callTool({ name: "forge_draft_pick", arguments: { card: "0" } });
    expect(posted(calls)).toEqual([{ card: "0" }, { card: "0", at: "3:1" }]);
    // The answer showed no pack, and the event for the next one may or may not have been read.
    const drafts = draftFor(bridge);
    drafts.pack({ ...named, at: "3:2", pickNumber: 2 }, { commit: false });
    expect(drafts.lastTold()).toBe("3:2");
    drafts.pack({ ...named, at: "3:3", pickNumber: 3 }, { commit: false });
    expect(drafts.lastTold()).toBeUndefined();
    await client.callTool({ name: "forge_draft_pick", arguments: { card: "0" } });
    expect(posted(calls).at(-1)).toEqual({ card: "0" });
    await client.close();
  });

  it("compares before the pick with a bridge that does not check, and says so", async () => {
    const { bridge, calls } = fakeBridge({ "GET /draft/pack": pack, "POST /draft/pick": made, "GET /wait": { ...idle, draft: { pickPending: false, picks: [] } } });
    const client = await connect(bridge);
    const stale = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0", at: "2:15" } })).structuredContent as Json;
    expect(stale).toMatchObject({ stale: true, at: "3:1" });
    expect(posted(calls)).toEqual([]);
    const answer = (await client.callTool({ name: "forge_draft_pick", arguments: { card: "0", at: "3:1" } })).structuredContent as Json;
    expect(answer).toMatchObject({ picked: { name: "Shock" }, weakCheck: true, waiting: true });
    expect(posted(calls)).toEqual([{ card: "0" }]);
    await client.close();
  });
});

describe("forge_draft_pack and forge_draft_pool", () => {
  it("return the bridge's own answer with full", async () => {
    const client = await connect(fakeBridge({ "GET /draft/pack": pack, "GET /draft/pool": pool }).bridge);
    expect((await client.callTool({ name: "forge_draft_pack", arguments: { full: true } })).structuredContent).toEqual(pack);
    expect((await client.callTool({ name: "forge_draft_pool", arguments: { full: true } })).structuredContent).toEqual(pool);
    const compact = (await client.callTool({ name: "forge_draft_pool", arguments: {} })).structuredContent as Json;
    expect(compact.cards).toHaveLength(39);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(pool).length * 0.6);
    const { cardText: _text, ...again } = (await client.callTool({ name: "forge_draft_pool", arguments: {} })).structuredContent as Json;
    expect(_text).toBeUndefined();
    expect(JSON.stringify(again).length).toBeLessThan(JSON.stringify(pool).length * 0.35);
    await client.close();
  });
});

describe("forge_draft_deck", () => {
  const built = fixture("draft-POST_draft_deck.json");
  const main = ["Serra Angel", "Volcanic Strength", "Volcanic Strength", "Plains"];
  const lobby = (ready: boolean) => ({ mySlot: 1, limitedMode: true, slots: [{ index: 0, name: "Ola", ready: true }, { index: 1, name: "Agent", ready }] });

  it("describes the deck once and says whether the seat is ready", async () => {
    const { bridge } = fakeBridge({ "POST /draft/deck": built, "GET /draft/pool": pool, "GET /status": { revision: 9, lobby: lobby(false) } });
    const client = await connect(bridge);
    const first = (await client.callTool({ name: "forge_draft_deck", arguments: { main, lands: { Plains: 17 } } })).structuredContent as Json;
    expect(first).toMatchObject({ size: 40, lands: 17, problem: null, ready: false });
    const cards = first.cards as Card[];
    expect(cards.map((c) => [c.name, c.count])).toEqual([["Serra Angel", 1], ["Volcanic Strength", 2], ["Plains", 1]]);
    expect(cards[0].text).toContain("Flying");
    expect(first.counts).toMatchObject({ count: 4, creatures: 1, other: 2, lands: 1, colors: { W: 1, R: 2 } });
    // The game leaves out the text of the cards described here.
    const game = { inGame: true, prompt: "Priority", promptCount: 1, priorityPrompt: true, turn: 1, phase: "MAIN1", players: [{ name: "Agent", isMe: true, life: 20, hand: [{ id: 1, name: "Serra Angel", text: "Flying, vigilance" }, { id: 2, name: "Shock", text: "Shock deals 2 damage to any target." }] }] };
    const view = await memoryFor(bridge).view(bridge, game, { commit: true });
    expect(view.cardText).toEqual({ Shock: "Shock deals 2 damage to any target." });
    // A changed deck has text only for the card that is new to it.
    const second = (await client.callTool({ name: "forge_draft_deck", arguments: { main: [...main, "Silence"], lands: {} } })).structuredContent as Json;
    expect((second.cards as Card[]).filter((c) => c.text !== undefined).map((c) => c.name)).toEqual(["Silence"]);
    await client.close();
  });

  it("still answers with the built deck when the status cannot be read", async () => {
    const client = await connect(fakeBridge({ "POST /draft/deck": built }).bridge);
    const res = await client.callTool({ name: "forge_draft_deck", arguments: { main, lands: {} } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(built);
    await client.close();
  });
});

describe("forge.your_move for a draft", () => {
  it("is emitted by the seat's watcher with the pack", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/wait") {
        await new Promise((r) => setTimeout(r, 20));
        return json({ revision: 4, game: { inGame: false }, draft: { ...named, pack: undefined } });
      }
      return path === "/draft/pack" ? json(named) : json({ error: `unknown route ${path}` }, 400);
    };
    const seat = createSeat(undefined, new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl }));
    const emitted = new Promise<EventOccurrence>((resolve) => seat.events.onEmit(resolve));
    seat.start(() => {});
    const { data } = await emitted;
    seat.stop();
    expect(data).toMatchObject({ kind: "draft_pick", at: "3:1", packNumber: 3, pickNumber: 1, drafted: { count: 30 } });
    expect(data.pack).toHaveLength(15);
    expect(Object.keys(data.cardText as Json).length).toBeGreaterThan(0);
  });

  it("carries the pack for a pick and the pool for a deck", async () => {
    const drafts = new DraftMemory();
    const moves = new MoveTracker(new EventLog());
    const picking = { revision: 2, game: { inGame: false }, draft: { packNumber: 3, pickNumber: 1, pickPending: true, secondsLeft: 118 } };
    const pick = await moves.observeWith(picking, async () => drafts.pack(pack, { commit: false }));
    expect(pick?.data).toMatchObject({ kind: "draft_pick", packNumber: 3, pickNumber: 1, secondsLeft: 120, drafted: { count: 30 } });
    expect(pick?.data.pack).toHaveLength(15);
    expect(Object.keys(pick?.data.cardText as Json)).toHaveLength(PACK_TEXTS);
    const seat = { mySlot: 1, limitedMode: true, slots: [{ index: 1, name: "Agent", ready: true }], event: { eventId: "e1", phase: "DRAFTING" } };
    const done = { revision: 3, game: { inGame: false }, lobby: seat, draft: { packNumber: 3, pickNumber: 15, pickPending: false, poolReceived: true, poolEventId: "e1" } };
    const deck = await moves.observeWith(done, async () => ({ pool: drafts.pool(pool, { commit: false }) }));
    expect(deck?.data).toMatchObject({ kind: "deck", pool: { size: 45, counts: { count: 45 } } });
  });

  it("asks an unready seat with its deck built for the ready flag alone", () => {
    const moves = new MoveTracker(new EventLog());
    const lobby = {
      mySlot: 1,
      limitedMode: true,
      slots: [{ index: 1, name: "Agent", ready: false }],
      event: { eventId: "e1", phase: "DRAFTING" },
      myDeck: { name: "Draft", mainSize: 40, sideboardSize: 22 },
    };
    const draft = { packNumber: 3, pickNumber: 15, pickPending: false, poolReceived: true, poolEventId: "e1" };
    expect(moves.observe({ revision: 4, game: { inGame: false }, lobby, draft })?.data).toMatchObject({
      kind: "lobby",
      prompt: "Your deck for the Limited match is set and you are not ready. Ready up with forge_lobby_ready.",
    });
  });
});
