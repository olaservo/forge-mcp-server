# Playing

What the game tools return and how they keep a game short in calls and in context. The `forge-player` skill tells an agent how to use them. This needs forge-agent-bridge 0.1.10. With an older bridge the tools work as before, without the arguments below.

## What an action returns

`forge_game_act` and `forge_game_decide` read the whole game from the bridge after the host has reacted and return a view of it (`src/view.ts`): the prompt, the enabled buttons, life totals, the seat's hand when it has priority, the stack with who put each item there and its targets, floating mana, combat, the selection the prompt offers, and a pending decision. A field with nothing to say is left out. `forge.your_move` carries the same view for a priority prompt or a choice in a game.

The server remembers what it has told the seat in the current game, so nothing is sent twice:

- `since` has what is new since the last tool result: game log lines without phase changes and mana (the last 15, with a count of older ones), cards new in hand, and messages.
- `cardText` has rules text only for card names not sent before. A card whose text differs from its name's keeps its own. The cards of the deck set with `forge_lobby_deck` count as sent. `forge_game_state` follows the same rule, and `allText: true` sends every name's text.
- `board`, both battlefields, comes when an event starts a turn and the first time an action returns the seat's own main phase in a turn.

An event may never reach the model: a client can drop one that a later event replaced. So what an event carried counts as told only when an action names that event's prompt with `at`. Without `at`, the next tool result repeats it.

A prompt that takes a spell or ability on the stack as a target, as a counterspell's does, lists the entries it accepts in `selection.stack`, and `forge_game_act` answers it with `selectStack` and the entry's `id`. Forge 2.0.16 has a network player pick these in the stack view, so a card id does not answer the prompt, and the bridge refuses a `selectCard` there. Before 2026-11-25 the bridge had no such action and a seat could not counter a spell.

Forge does not tell a network client that it ignored a click: its `NetGameController.selectCard` answers true whatever the host's input did. A bridge after 0.1.10 compares the game before and after a `selectCard`, `selectPlayer` or `selectStack`, and the view has `unchanged: true` when nothing but the prompt count differs. A click the host accepted with no visible effect reads the same way. `refused: true` follows Forge's incorrect-action flash, which 2.0.16 sends a network client for a player that cannot be attacked and for no card click.

Each `combat` entry has `blocksFinal` from the same bridge. `blocked: false` with `blocksFinal: false` means blockers are still being declared, and `blockers` lists the ones planned so far. `blocked: false` with `blocksFinal: true` is an unblocked attacker.

Card text is made plain on the way: Forge's blank Windows lines become one line break, and text Forge shows in gray because it does not apply now is marked `[inactive]`.

## Fewer prompts

The bridge sends the host the seat's stops, as Forge's desktop client does, and the host passes priority elsewhere while the stack is empty. The bridge README lists them. On top of that, `forge_game_act` takes:

- `pay: "auto"`: press Auto when the action leads to the prompt that pays a cost.
- `pass: true`: afterwards, pass priority if the seat's own spell or ability is on top of the stack.
- `ok` with the seat's own spell or ability on top of the stack yields until the stack is empty. `once: true` passes one time.
- `endTurn`, as an action, with `ok`, or with a cast: yield until the end of the turn.
- `at`: the `promptCount` the action answers. If it is no longer the current one the action is not sent and the answer has `stale: true`.

Measured before these existed, on 2026-11-23 and 2026-11-24: about half of a seat's `forge_game_act` calls in three games passed a prompt with nothing to decide.

## What a shortcut gives up, and what it never does

Magic gives a player priority in every step. A seat that is asked at every one of them spends half its calls passing, and a seat that is asked nowhere cannot play the game. These are the lines drawn here.

- A response to an opponent is never skipped. A yield from `ok`, `pass` or `endTurn` ends when an opponent casts a spell, activates an ability, has a trigger go on the stack, or attacks the seat, and the seat is asked with their item on top of the stack before anything resolves. The bridge's `AgentInterruptTest` plays this against a host that counters the seat's spell, for the stack yield and for the end of turn yield. An activated ability and a trigger have not been played: Forge fires the same event for them as for a spell (`MagicStack.add`), which is what ends the yield.
- After `endTurn` on its own turn, and on an opponent's turn, the host asks only a seat that could play or activate something, by Forge's own check of its hand and battlefield against its mana. That check can miss an ability used from the graveyard. A seat with nothing it could play is not asked, and reads what happened in `since.log`.
- Between its own items the seat is not asked after a plain `ok`. `once` asks again before the next one resolves.
- With an empty stack the seat is not asked in its own upkeep, draw step, beginning of combat, after it declares attackers, or in its end step, nor in an opponent's upkeep, draw step or main phases. These are Forge's desktop defaults. A deck that needs one of those windows adds it with `forge_game_stops`, below.
- `endTurn` with the attack skips the prompt after blockers are declared, where a combat trick is played. The guide says to leave it out when holding one.

## The seat's own stops

`forge_game_stops` returns and sets the steps where the host asks the seat on an empty stack, for its own turn and for an opponent's. It is what a player does on Forge's desktop by clicking a phase label, and the bridge sends each change to the host the same way. The defaults are not changed by anything else.

- It is there first for a deck that needs a window the defaults leave out, such as its own upkeep or end step.
- A seat may also remove a stop. On 2026-11-24 a seat with a burn deck was asked at all four default stops of each opponent turn, 14 of its 60 actions, because it always held an instant it could pay for. That is the game working as it should, and whether to give up one of those windows is the player's choice. The guide tells a seat to leave the defaults unless its deck gives it a reason.
- `own` must include `MAIN1`, since a seat that is not asked there cannot play a land.
- Removing the stop the seat is being asked at, with an empty stack, passes that prompt. The answer's `game` has what the seat is asked next.
- An opponent's spell or ability, blocks and choices are asked whatever the stops.

## Knowing the deck

`forge_lobby_deck` answers with the deck's description and `cards`: each card of the main deck with its count, cost, type, power and toughness and rules text, read from Forge's card scripts in `FORGE_HOME`. `forge_decks` with an `id` lists a deck as one row per card name, and `dck: true` adds the file's text.

## Smaller answers

- `forge_status`, `forge_connect`, `forge_disconnect` and `forge_wait` leave out `draft` when the seat has no draft and no pool.
- `forge_decks` leaves out the folders table once the list is narrowed.
- After `quit`, `forge_game_act` answers `{left: true, lobby}`.
