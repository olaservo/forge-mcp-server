/** Card fields left out of the compact game state when they hold this value. */
export const DEFAULTS: Record<string, unknown> = {
  tapped: false,
  sick: false,
  attacking: false,
  blocking: false,
  damage: 0,
  token: false,
  faceDown: false,
  phasedOut: false,
  manaCost: "no cost",
  text: "",
};

type Card = Record<string, unknown>;

/**
 * The bridge's game state with less repetition. Card fields at their default value are left out, and so is
 * `zone` or `controller` where the list a card is in already says it. Rules text goes once per card name into
 * `cardText`. A card whose text differs from its name's entry, such as a creature that gained an ability,
 * keeps its own `text`.
 */
export function compactGame(game: Record<string, unknown>): Record<string, unknown> {
  const cardText: Record<string, string> = {};
  const compact = (card: Card, zone?: string, controller?: unknown): Card => {
    const out: Card = {};
    for (const [key, value] of Object.entries(card)) {
      if (value === null || value === undefined || DEFAULTS[key] === value) continue;
      if (key === "zone" && value === zone) continue;
      if (key === "controller" && value === controller) continue;
      if (key === "text" && typeof value === "string" && typeof card.name === "string") {
        const known = cardText[card.name];
        if (known === undefined) cardText[card.name] = value;
        if (known === undefined || known === value) continue;
      }
      out[key] = value;
    }
    return out;
  };
  const list = (cards: unknown, zone?: string, controller?: unknown) =>
    Array.isArray(cards) ? cards.map((c) => compact(c as Card, zone, controller)) : cards;

  const players = Array.isArray(game.players)
    ? game.players.map((p: Record<string, unknown>) => ({
        ...p,
        battlefield: list(p.battlefield, "Battlefield", p.name),
        graveyard: list(p.graveyard, "Graveyard", p.name),
        ...(p.hand === undefined ? {} : { hand: list(p.hand, "Hand", p.name) }),
        ...(p.libraryTop ? { libraryTop: compact(p.libraryTop as Card, "Library", p.name) } : {}),
      }))
    : game.players;
  const selection = game.selection as Record<string, unknown> | null | undefined;
  const result: Record<string, unknown> = {
    ...game,
    players,
    ...(selection ? { selection: { ...selection, cards: list(selection.cards) } } : {}),
  };
  if (game.players !== undefined) result.cardText = cardText;
  return result;
}
