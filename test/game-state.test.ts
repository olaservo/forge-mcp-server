import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactGame } from "../src/game-state.js";
import { GameState } from "../src/schemas.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("compactGame", () => {
  it("leaves out default fields and moves rules text to cardText", () => {
    const game = fixture("game-GET_game.json");
    const compact = compactGame(game);
    expect(GameState.safeParse(compact).success).toBe(true);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(game).length * 0.6);
    const me = (compact.players as { hand?: Record<string, unknown>[] }[]).find((p) => p.hand)!;
    const bushwhacker = me.hand!.find((c) => c.name === "Goblin Bushwhacker")!;
    expect(bushwhacker).toEqual({ id: 4, name: "Goblin Bushwhacker", type: "Creature - Goblin Warrior", manaCost: "{R}", power: 1, toughness: 1 });
    expect((compact.cardText as Record<string, string>)["Goblin Bushwhacker"]).toMatch(/^Kicker/);
  });

  it("keeps a field that differs from its default and a text that differs from its name's entry", () => {
    const card = (id: number, more: object) => ({ id, name: "Bear", zone: "Battlefield", controller: "A", tapped: false, damage: 0, text: "", ...more });
    const compact = compactGame({
      players: [{ name: "A", battlefield: [card(1, { tapped: true, text: "Trample" }), card(2, { damage: 1, text: "Trample\nFlying" }), card(3, { controller: "B", text: "Trample" })], graveyard: [] }],
    });
    const field = (compact.players as { battlefield: object[] }[])[0].battlefield;
    expect(field).toEqual([
      { id: 1, name: "Bear", tapped: true },
      { id: 2, name: "Bear", damage: 1, text: "Trample\nFlying" },
      { id: 3, name: "Bear", controller: "B" },
    ]);
    expect(compact.cardText).toEqual({ Bear: "Trample" });
  });

  it("keeps the zone of a selection card", () => {
    const compact = compactGame({ players: [], selection: { min: 1, max: 1, cards: [{ id: 9, name: "Forest", zone: "Library", tapped: false }] } });
    expect((compact.selection as { cards: object[] }).cards).toEqual([{ id: 9, name: "Forest", zone: "Library" }]);
  });
});
