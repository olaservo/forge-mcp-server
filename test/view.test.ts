import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { View } from "../src/schemas.js";
import { SeatMemory, plainText } from "../src/view.js";
import { fakeBridge } from "./helpers.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

const card = (id: number, name: string, more: object = {}) => ({ id, name, zone: "Hand", controller: "Me", tapped: false, sick: false, damage: 0, type: "Instant", manaCost: "{R}", text: `${name} text`, ...more });

/** A game on the seat's main phase with two cards in hand and a creature on each side. */
function game(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inGame: true,
    finished: false,
    prompt: "Priority: Me\nTurn: 3 (Me)\nPhase: Main phase, precombat\nStack: Empty",
    promptCount: 7,
    waiting: false,
    priorityPrompt: true,
    promptCard: null,
    buttons: { ok: "OK", okEnabled: true, cancel: "End Turn", cancelEnabled: true },
    incorrectActions: 0,
    messages: [],
    messageCount: 0,
    logCount: 4,
    turn: 3,
    phase: "MAIN1",
    activePlayer: "Me",
    gameOver: false,
    winner: "",
    me: "Me",
    hasPriority: true,
    autoPass: "opponent-turns",
    autoPassNow: false,
    stops: "default",
    players: [
      {
        id: 0,
        name: "Me",
        life: 18,
        isMe: true,
        handSize: 2,
        librarySize: 40,
        graveyardSize: 0,
        exileSize: 0,
        mana: {},
        battlefield: [card(10, "Bear", { zone: "Battlefield", type: "Creature - Bear", manaCost: "{1}{G}", power: 2, toughness: 2 })],
        graveyard: [],
        hand: [card(1, "Shock"), card(2, "Mountain", { type: "Basic Land - Mountain", manaCost: "no cost", text: "" })],
      },
      {
        id: 1,
        name: "Them",
        life: 20,
        isMe: false,
        handSize: 5,
        librarySize: 41,
        graveyardSize: 1,
        exileSize: 0,
        mana: {},
        battlefield: [card(20, "Goblin", { zone: "Battlefield", controller: "Them", type: "Creature - Goblin", power: 1, toughness: 1, tapped: true })],
        graveyard: [],
      },
    ],
    stack: [],
    ...more,
  };
}

const LOG = ["Turn: Turn 3 (Me)", "Phase: Me's Upkeep step", "Mana: Mountain (5) - {T}: Add {R}.", "Land: Me played Mountain (5)"];
const bridgeWith = (log = LOG) => fakeBridge({ "GET /game/log": { log } }).bridge;

describe("plainText", () => {
  it("joins Forge's blank Windows lines and marks text that does not apply", () => {
    expect(plainText('Double strike\r\n\r\n<span style="color:gray;">Haste</span>\r\n\r\nWhen it dies, draw a card.')).toBe("Double strike\n[inactive] Haste\nWhen it dies, draw a card.");
  });
});

describe("the view an action returns", () => {
  it("carries the ask, the hand, life, the board once a turn, new text and what happened", async () => {
    const memory = new SeatMemory();
    const view = await memory.view(bridgeWith(), game(), { commit: true });
    expect(View.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ promptCount: 7, turn: 3, phase: "MAIN1", activePlayer: "Me", buttons: { ok: "OK", cancel: "End Turn" }, life: { Me: 18, Them: 20 } });
    expect(view.hand).toEqual([
      { id: 1, name: "Shock", type: "Instant", manaCost: "{R}" },
      { id: 2, name: "Mountain", type: "Basic Land - Mountain" },
    ]);
    expect(view.cardText).toEqual({ Shock: "Shock text", Bear: "Bear text", Goblin: "Goblin text" });
    expect((view.board as { battlefield: unknown[] }[])[1].battlefield).toEqual([{ id: 20, name: "Goblin", tapped: true, type: "Creature - Goblin", manaCost: "{R}", power: 1, toughness: 1 }]);
    expect(view.since).toEqual({ log: ["Turn: Turn 3 (Me)", "Land: Me played Mountain (5)"] });
    for (const absent of ["inGame", "waiting", "stack", "mana", "refused", "stale", "gameOver", "messages", "autoPass", "me"]) expect(view).not.toHaveProperty(absent);
  });

  it("sends nothing twice: no board, no text and no log on the next ask of the turn", async () => {
    const memory = new SeatMemory();
    await memory.view(bridgeWith(), game(), { commit: true });
    const next = await memory.view(bridgeWith([]), game({ promptCount: 8 }), { commit: true });
    expect(next).not.toHaveProperty("board");
    expect(next).not.toHaveProperty("cardText");
    expect(next).not.toHaveProperty("since");
    expect((next.hand as unknown[]).length).toBe(2);
  });

  it("reports a new card in hand, a refused action, the stack and floating mana", async () => {
    const memory = new SeatMemory();
    await memory.view(bridgeWith(), game(), { commit: true });
    const g = game({ promptCount: 9, logCount: 4, incorrectActions: 1, stack: [{ id: 3, source: "Shock", by: "Them", text: "Shock (9) deals 2 damage to Bear (10).\r\n", targets: ["Bear#10"] }] });
    const me = (g.players as Record<string, unknown>[])[0];
    me.hand = [...(me.hand as object[]), card(3, "Bolt")];
    me.mana = { R: 2 };
    const view = await memory.view(bridgeWith([]), g, { commit: true });
    expect(view.since).toEqual({ newInHand: ["Bolt"] });
    expect(view.refused).toBe(true);
    expect(view.stack).toEqual([{ by: "Them", source: "Shock", text: "Shock (9) deals 2 damage to Bear (10).", targets: ["Bear#10"] }]);
    expect(view.mana).toEqual({ R: 2 });
    expect(view.cardText).toEqual({ Bolt: "Bolt text" });
  });

  it("leaves out the hand and offers nothing while the seat waits", async () => {
    const view = await new SeatMemory().view(bridgeWith(), game({ waiting: true, priorityPrompt: false, prompt: "Waiting for Them...", buttons: { ok: "OK", okEnabled: false, cancel: "Cancel", cancelEnabled: false } }), { commit: true });
    expect(view.waiting).toBe(true);
    for (const absent of ["hand", "buttons", "board", "selection", "actionable"]) expect(view).not.toHaveProperty(absent);
  });

  it("shows the opening hand at the prompt that asks whether to keep it", async () => {
    const keep = game({ prompt: "Me, you are going first!\n\nDo you want to keep your hand?", priorityPrompt: false, turn: 0, phase: null, activePlayer: null, buttons: { ok: "Keep", okEnabled: true, cancel: "Mulligan", cancelEnabled: true } });
    const view = await new SeatMemory().view(bridgeWith([]), keep, { commit: true });
    expect((view.hand as { name: string }[]).map((c) => c.name)).toEqual(["Shock", "Mountain"]);
    expect(view).not.toHaveProperty("board");
  });

  it("does not repeat the text of the deck the seat was told of", async () => {
    const memory = new SeatMemory();
    memory.brief(["Shock", "Bear"]);
    const view = await memory.view(bridgeWith(), game(), { commit: true });
    expect(view.cardText).toEqual({ Goblin: "Goblin text" });
  });

  it("keeps a card's own text when it differs from its name's", async () => {
    const memory = new SeatMemory();
    await memory.view(bridgeWith(), game(), { commit: true });
    const g = game({ promptCount: 8, turn: 5 });
    ((g.players as { battlefield: Record<string, unknown>[] }[])[0].battlefield[0]).text = "Bear text\r\n\r\nTrample";
    const view = await memory.view(bridgeWith([]), g, { commit: true });
    expect((view.board as { battlefield: Record<string, unknown>[] }[])[0].battlefield[0].text).toBe("Bear text\nTrample");
  });

  it("an event's view is repeated by the next action unless the action names its prompt", async () => {
    const memory = new SeatMemory();
    const event = await memory.view(bridgeWith(), game(), { commit: false, board: true });
    expect(event.since).toBeDefined();
    expect(event.board).toBeDefined();
    const unseen = await memory.view(bridgeWith(), game(), { commit: true });
    expect(unseen.since).toEqual(event.since);

    const other = new SeatMemory();
    await other.view(bridgeWith(), game(), { commit: false, board: true });
    other.saw(7);
    const seen = await other.view(bridgeWith([]), game({ promptCount: 8 }), { commit: true });
    for (const absent of ["since", "board", "cardText"]) expect(seen).not.toHaveProperty(absent);
  });

  it("starts over when a new game counts its log from nothing", async () => {
    const memory = new SeatMemory();
    await memory.view(bridgeWith(), game(), { commit: true });
    const view = await memory.view(bridgeWith(["Turn: Turn 1 (Them)"]), game({ logCount: 1, turn: 1, promptCount: 30 }), { commit: true });
    expect(view.since).toEqual({ log: ["Turn: Turn 1 (Them)"] });
    expect(view.cardText).toBeDefined();
  });

  it("keeps the last 15 log lines and counts the older ones", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Land: line ${i}`);
    const view = await new SeatMemory().view(bridgeWith(lines), game({ logCount: 20 }), { commit: true });
    expect((view.since as { log: string[]; earlier: number }).log).toHaveLength(15);
    expect((view.since as { earlier: number }).earlier).toBe(5);
  });

  it("is built from a recorded game", async () => {
    const view = await new SeatMemory().view(bridgeWith([]), fixture("game-GET_game.json"), { commit: true });
    expect(View.safeParse(view).success).toBe(true);
    expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(fixture("game-GET_game.json")).length);
  });

  it("says whether the blocks are final, from recorded combats", async () => {
    type Attack = { blockers: string[]; blocked: boolean; blocksFinal: boolean };
    const combat = async (name: string) => {
      const view = await new SeatMemory().view(bridgeWith([]), fixture(name), { commit: true });
      expect(View.safeParse(view).success).toBe(true);
      return view.combat as Attack[];
    };
    // A blocker is chosen and OK is not pressed: nothing is settled, for the other attacker either.
    const planned = await combat("combatSignals-GET_game_plannedBlock.json");
    expect(planned.map((a) => [a.blockers.length, a.blocked, a.blocksFinal])).toEqual([[1, false, false], [0, false, false]]);
    // After OK one attacker is blocked and the other is unblocked.
    const declared = await combat("combatSignals-GET_game_blocked.json");
    expect(declared.map((a) => [a.blockers.length, a.blocked, a.blocksFinal])).toEqual([[1, true, true], [0, false, true]]);
  });

  it("marks a click that changed nothing only when told so", async () => {
    const memory = new SeatMemory();
    expect(await memory.view(bridgeWith(), game(), { commit: true, unchanged: true })).toMatchObject({ unchanged: true });
    expect(await memory.view(bridgeWith([]), game(), { commit: true })).not.toHaveProperty("unchanged");
  });
});

describe("forge_game_state through the memory", () => {
  it("sends each name's text once, and again with allText", async () => {
    const memory = new SeatMemory();
    const first = await memory.state(bridgeWith(), game(), false);
    expect(first.cardText).toEqual({ Shock: "Shock text", Bear: "Bear text", Goblin: "Goblin text" });
    expect(first).not.toHaveProperty("messages");
    const second = await memory.state(bridgeWith([]), game(), false);
    expect(second.cardText).toEqual({});
    const all = await memory.state(bridgeWith([]), game(), true);
    expect(Object.keys(all.cardText as object).sort()).toEqual(["Bear", "Goblin", "Shock"]);
  });
});
