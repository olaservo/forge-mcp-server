# Playing

What the game tools return and how they keep a game short in calls and in context. The `forge-player` skill tells an agent how to use them. This needs forge-agent-bridge 0.1.10. With an older bridge the tools work as before, without the arguments below.

## What an action returns

`forge_game_act` and `forge_game_decide` read the whole game from the bridge after the host has reacted and return a view of it (`src/view.ts`): the prompt, the enabled buttons, life totals, the seat's hand when it has priority, the stack with who put each item there and its targets, floating mana, combat, the selection the prompt offers, and a pending decision. A field with nothing to say is left out. `forge.your_move` carries the same view for a priority prompt or a choice in a game.

The server remembers what it has told the seat in the current game, so nothing is sent twice:

- `since` has what is new since the last tool result: game log lines without phase changes and mana (the last 15, with a count of older ones), cards new in hand, and messages.
- `cardText` has rules text only for card names not sent before. A card whose text differs from its name's keeps its own. The cards of the deck set with `forge_lobby_deck` count as sent. `forge_game_state` follows the same rule, and `allText: true` sends every name's text.
- `board`, both battlefields, comes when an event starts a turn and the first time an action returns the seat's own main phase in a turn.

An event may never reach the model: a client can drop one that a later event replaced. So what an event carried counts as told only when an action names that event's prompt with `at`. Without `at`, the next tool result repeats it.

Card text is made plain on the way: Forge's blank Windows lines become one line break, and text Forge shows in gray because it does not apply now is marked `[inactive]`.

## Fewer prompts

The bridge sends the host the seat's stops, as Forge's desktop client does, and the host passes priority elsewhere while the stack is empty. The bridge README lists them. On top of that, `forge_game_act` takes:

- `pay: "auto"`: press Auto when the action leads to the prompt that pays a cost.
- `pass: true`: afterwards, pass priority if the seat's own spell or ability is on top of the stack.
- `ok` with the seat's own spell or ability on top of the stack yields until the stack is empty. `once: true` passes one time.
- `endTurn`, as an action or with `ok`: yield until the end of the turn.
- `at`: the `promptCount` the action answers. If it is no longer the current one the action is not sent and the answer has `stale: true`.

Measured before these existed, on 2026-11-23 and 2026-11-24: about half of a seat's `forge_game_act` calls in three games passed a prompt with nothing to decide.

## Knowing the deck

`forge_lobby_deck` answers with the deck's description and `cards`: each card of the main deck with its count, cost, type, power and toughness and rules text, read from Forge's card scripts in `FORGE_HOME`. `forge_decks` with an `id` lists a deck as one row per card name, and `dck: true` adds the file's text.

## Smaller answers

- `forge_status`, `forge_connect`, `forge_disconnect` and `forge_wait` leave out `draft` when the seat has no draft and no pool.
- `forge_decks` leaves out the folders table once the list is narrowed.
- After `quit`, `forge_game_act` answers `{left: true, lobby}`.
