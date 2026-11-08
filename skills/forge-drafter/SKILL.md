---
name: forge-drafter
description: Draft a seat in a Forge network booster draft through the forge_draft_* tools, from joining the lobby to receiving the pool and readying the deck for the Limited match. Use whenever the host has configured a draft event or forge_status shows a pack waiting.
---

# Drafting in Forge

The host configures the event in their lobby (product, pod size, pick timer) and starts it. Each human seat gets packs one at a time; AI seats pick instantly. Your job is the pick loop.

## Pick loop

1. `forge_connect`, then `forge_wait` until `draft.pickPending` is true.
2. `forge_draft_pack`: `packNumber`, `pickNumber`, `timerSeconds` (0 means no clock) and `pack[]` with each card's `index`, `name`, `manaCost`, `type`, `colors`, `power`, `toughness`, `rarity` and `oracle`.
3. Decide, then `forge_draft_pick {card: "<exact name>"}` (or the index). The result confirms the card.
4. `forge_wait` with the returned `revision` until the next pack arrives or `draft.poolReceived` becomes true.

If the pick timer runs out the host auto-picks for you; those cards show up in `draft.autoPicks`. Keep picks under the timer: decide from the pack text you have, do not fetch extra data on the clock unless the timer is generous.

`draft.picks` is your running pick list. `draft.seatQueueDepths` shows how many packs are queued at each seat, which hints at who is slow.

## Pick heuristics

Unless a persona skill says otherwise:

- First picks: removal and bombs over everything; evasive or efficient creatures next; situational cards last.
- By pick 4 or 5 settle into at most two colors, and read what is flowing: a strong card in a color late in pack 1 means the seats passing to you are not in it.
- Count creatures. A 40-card deck wants roughly 15 to 17 creatures, 6 to 8 spells, 17 lands (16 with a low curve). Draft to that shape in packs 2 and 3.
- Curve: prefer two- and three-drops when you have none; do not take a fifth five-drop.
- Late picks: playables in your colors over off-color power. Sideboard-grade answers (artifact and enchantment removal) are fine last picks.

## After the draft

`forge_draft_pool` returns the pool with its `eventId` tags and the `.dck` path Forge saved it to. Forge delivers every pick in the `Sideboard` section with an empty `Main`, so the pool is not yet a deck. Build one: choose 22 or 23 spells from the pool, add basic lands to reach 40, and submit it with `forge_lobby_deck {dck}` as deck-file text that keeps the pool's `Name` and `Tags` lines from the metadata (the tags are how the Limited lobby recognises the deck as belonging to this event):

```
[metadata]
Name=<pool name from forge_draft_pool>
Tags=<the tags, comma separated>
[Main]
17 Forest|M11
1 Garruk's Companion|M11
...
[Sideboard]
1 Naturalize|M11
...
```

Basic lands can be named with the set code of the draft's land set (`LandSetCode` in the pool, or the set you drafted). Then `forge_lobby_ready` and switch to the `forge-player` skill for the match. Submitting the raw pool with no arguments works only when the host has deck conformance off.
