---
name: forge-drafter
description: Draft a seat in a Forge network booster draft or sealed event through the forge_draft_* tools, from joining the lobby to building the deck from the pool for the Limited match. Use whenever the host has configured a draft or sealed event or forge_status shows a pack waiting.
---

# Drafting in Forge

The host configures the event in their lobby (product, pod size, pick timer) and starts it. Each human seat gets packs one at a time; AI seats pick instantly. Your job is the pick loop, then the deck.

## Pick loop

1. `forge_connect`, then `forge_lobby_ready` straight away: the host cannot start the event while any seat is unready, and in a Limited lobby no deck is needed to be ready before the draft. Then `forge_wait` until `draft.pickPending` is true.
2. `forge_draft_pack`: `packNumber` and `pickNumber` (both count from 1), `timerSeconds` (0 means no clock), `secondsLeft` when there is a clock, and `pack[]` with each card's `index`, `name`, `manaCost`, `type`, `colors`, `power`, `toughness`, `rarity` and `oracle`.
3. Decide, then `forge_draft_pick {card: "<exact name>"}` (or the index). The result confirms the card.
4. `forge_wait` with the returned `revision` until the next pack arrives or `draft.poolReceived` becomes true. If your client delivers `forge.your_move` events, end your turn here instead; the next pack starts a new one.

If the pick timer runs out the host takes the first card of the pack for you; those cards show up in `draft.autoPicks`. Keep picks under the timer: decide from the pack text you have, do not fetch extra data on the clock unless `secondsLeft` is generous. The clock runs from when the pack arrived, so a pack that was waiting while you thought has less left than `timerSeconds`.

`draft.picks` is your running pick list. `draft.seatQueueDepths` shows how many packs are queued at each seat, which hints at who is slow.

## Pick heuristics

Unless a persona skill says otherwise:

- First picks: removal and bombs over everything; evasive or efficient creatures next; situational cards last.
- By pick 4 or 5 settle into at most two colors, and read what is flowing: a strong card in a color late in pack 1 means the seats passing to you are not in it.
- Count creatures. A 40-card deck wants roughly 15 to 17 creatures, 6 to 8 spells, 17 lands (16 with a low curve). Draft to that shape in packs 2 and 3.
- Curve: prefer two- and three-drops when you have none; do not take a fifth five-drop.
- Late picks: playables in your colors over off-color power. Sideboard-grade answers (artifact and enchantment removal) are fine last picks.

## After the draft

The pool arrives when the last pick is made (`draft.poolReceived`, or a `forge.your_move` event of kind `deck`). `forge_draft_pool` returns it with its `eventId` tags and the `.dck` path Forge saved it to. Forge delivers every pick in the `Sideboard` section with an empty `Main`, so the pool is not yet a deck.

Build one with `forge_draft_deck`: name the 22 or 23 pool cards you play in `main`, one entry per copy, and the basic lands in `lands`. Basic lands are free and need not be in the pool.

```
forge_draft_deck {
  "main": ["Doom Blade", "Barony Vampire", "Barony Vampire", "Chandra's Outrage", ...],
  "lands": {"Swamp": 9, "Mountain": 8}
}
```

The tool keeps the pool's name and event tags, puts the cards you left out in the sideboard, sets the deck on your lobby slot and saves it over the pool file. It refuses a card that is not in the pool. `problem` in the result is null when the deck is legal; a deck under 40 cards is not. Call it again to change the deck.

Your ready flag from before the draft stays set; check `lobby.slots` in `forge_status` and `forge_lobby_ready` again only if it shows you unready. `lobby.myDeck` shows the deck you set. Then switch to the `forge-player` skill for the match.

## Sealed

A sealed event has no picks. Ready up, and when the host starts it the pool arrives at once (six boosters, about 84 cards). Build the deck from it the same way.
