---
name: forge-drafter
description: Draft a seat in a Forge network booster draft or sealed event through the forge_draft_* tools, from joining the lobby to building the deck from the pool for the Limited match. Use whenever the host has configured a draft or sealed event or forge_status shows a pack waiting.
---

# Drafting in Forge

The host sets up the event in their lobby (product, pod size, pick timer) and starts it. Each human seat gets one pack at a time, and AI seats pick at once. You make the picks, then build the deck.

## How you are told

A `forge.your_move` event starts a turn each time the seat is asked something: `lobby` when you are not ready, `draft_pick` for a pack, `deck` when the pool arrives. If events wake your seat, act on the event and end your turn. `forge_wait` is refused for such a seat, and the refusal says to end the turn.

A client with no events calls `forge_wait` where this guide says to end the turn. It returns the status when the seat is asked something. Pass it the `revision` of your last status as `since`, or the `revision` of a pick answered `waiting: true`: with no `since` it returns at once. Then read the pack with `forge_draft_pack`, or the pool with `forge_draft_pool`. If you do not know whether events wake you, call `forge_wait` once after you ready: it either waits or is refused.

## Pick loop

1. `forge_connect`, then `forge_lobby_ready` straight away. The host cannot start the event while a seat is unready, and no deck is needed to ready before a draft. End your turn.
2. A `draft_pick` event carries the pack. If it has no `pack`, read the pack with `forge_draft_pack`. `packNumber` and `pickNumber` count from 1. `secondsLeft` is the pick clock, when the host set one. `queued` is the host's last count of packs waiting behind this one, when other seats are waiting on you. `pack` has each card's `name`, `manaCost`, `type`, `pt`, and its `rarity` unless it is Common.
3. Rules text is in `cardText` under the card's name. It is sent once per card name in a draft. A pack that comes round the table again has no text for cards you were already sent, and a creature with no abilities has none. `forge_draft_pack {allText: true}` sends the text of the current pack again. The server remembers what it sent for as long as it runs, whatever conversation asked. In a new conversation, or after your context was compacted, ask for the text again with `allText: true` on `forge_draft_pack` or `forge_draft_pool`.
4. `drafted` counts your picks so far: `colors`, `creatures`, `other` spells, `lands`, and `curve`, the number of spells at each mana value. `unknown` counts picks the server never saw in a pack.
5. Pick with `forge_draft_pick {card: "<exact name>", at: "<the pack's at>"}`. `picked` confirms the card. A pick without `at` is not made. If the clock ran out and another pack is waiting, nothing is picked and the answer has `stale: true` with that pack: pick from it. If it has `stale: true` and `waiting: true`, the host picked for you and the next pack has not come: end your turn.
6. The answer has what you are asked next. If it has a `pack`, the next pack was already waiting: pick from it in the same turn. If it has `waiting: true`, another seat is still picking: end your turn, and the next event brings the pack. After the last pick it has `poolReceived: true`, with `pool` when the pool has arrived.

A pick made from the event's pack needs no other call. When you have the pack, do not call `forge_draft_pack` or `forge_status` before the pick.

If the clock runs out the host takes the first card of the pack for you. Those picks are listed in `autoPicks`. The clock runs from when the pack arrived. `secondsLeft` was read when the event was made, so an event that waited while you were busy has less left than it says. Decide from the pack you have, and do not look cards up on the clock unless `secondsLeft` is generous.

## Pick heuristics

Unless a persona skill says otherwise:

- First picks: removal and bombs first, then evasive or efficient creatures, then situational cards.
- By pick 4 or 5 settle into at most two colors. A strong card in a color late in pack 1 means the seats passing to you are not in it.
- Count creatures in `drafted`. A 40-card deck wants 15 to 17 creatures, 6 to 8 other spells and 17 lands (16 with a low curve). Draft to that shape in packs 2 and 3.
- Curve: take two- and three-drops when `curve` has few. Do not take a fifth five-drop.
- Late picks: playables in your colors over off-color power. Artifact and enchantment removal for the sideboard is a fine last pick.

## After the draft

The pool arrives when every seat has made its last pick. A `deck` event carries it in `pool`, and so does the answer to your last pick when the pool came in time. `forge_draft_pool` returns the same.

`pool.cards` has one entry per card name with its `count`, sorted by colour and then cost. `pool.counts` counts the pool the way `drafted` counts picks. `cardText` has text only for names the draft did not send you.

Build the deck with `forge_draft_deck`. Name the 22 or 23 pool cards you play in `main`, one entry per copy, and the basic lands in `lands`. Basic lands are free and need not be in the pool.

```
forge_draft_deck {
  "main": ["Doom Blade", "Barony Vampire", "Barony Vampire", "Chandra's Outrage", ...],
  "lands": {"Swamp": 9, "Mountain": 8}
}
```

The cards you leave out become the sideboard. A name that is not in the pool, or more copies than the pool has, is an error and no deck is set. `problem` is null when the deck is legal. A deck under 40 cards has a `problem` and is still set, so call the tool again with a legal one. Call it again also to change the deck.

The answer has `cards`: each pool card of the main deck with its count, cost, type and rules text, and `counts` for the deck. Read it once and note how the deck wins, which hands to keep and which cards to hold. The game does not send these cards' text again.

`ready` in the answer is your ready flag. It normally stays set from before the draft. If it is false, call `forge_lobby_ready`. Then load the `forge-player` skill and end your turn. The host starts the match, and the first game event brings your opening hand.

## Sealed

A sealed event has no picks. Ready up, and when the host starts it the pool arrives at once (six boosters, 84 to 90 cards) with the text of every card. Build the deck from it the same way.
