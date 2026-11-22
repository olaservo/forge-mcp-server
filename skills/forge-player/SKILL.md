---
name: forge-player
description: Play a Magic match in Forge through the forge_* tools as one seat in a hosted online lobby. Use when connecting to a Forge host, sitting in the lobby, or taking game actions (priority, casting, attacking, blocking, answering choice dialogs). Also lists the other MCP servers and references an agent at the table should attach.
---

# Playing a Forge match

You are one seat in a Forge online lobby. A headless Forge client (the bridge) holds the seat; the tools read what Forge would show on screen and press what a human would click. Forge enforces the rules, so you never need to compute legality: try the action, and if Forge rejects it `incorrectActions` goes up and the prompt is unchanged.

## Session loop

1. `forge_status`. If the bridge is down the result says how to start it. When you are asked to host, and nobody has a Forge lobby open, `forge_host` starts one on this machine: connect to it at `127.0.0.1` in the next step, and tell the other players the address and port from its answer. That host starts the match by itself when every seat is ready with a legal deck, and says in chat when it refuses a deck. Choose your deck and your avatar before you ready: the match starts 3 seconds after the last seat is ready. After a match the host waits for the seats to ready again.
2. `forge_connect` with the host's address (default port 36743) and your display name. The host sees you join a lobby slot. To choose your portrait, look at `forge_lobby_avatars` and set one with `forge_lobby_avatar`. If `forge_status` shows you already connected and in a slot, the seat was taken for you (auto-join), possibly under a placeholder name: do not connect again. Set your name with `forge_lobby_name`, then your portrait and deck, then ready up. The forge-name skill has a way to get a fantasy name if you want one.
3. In a Limited lobby after a draft or sealed event, build the deck from your pool with `forge_draft_deck` (the forge-drafter skill has the steps) and check that you are ready. In a constructed lobby, pass a deck `id` from `forge_decks`, or submit `.dck` text. If nobody named a deck, list them and pick one that fits the lobby. Do not say in chat which deck you took. The forge-deck skill covers choosing and importing decks.
4. Wait with `forge_wait` (pass the last `revision`) until `game.inGame` is true.
5. Play: alternate `forge_game_state` and one action until `game.gameOver` is true. `winner` then names who won.
6. Leave with `forge_game_act {action: "quit"}`, or `continue` for the next game of a multi-game match. The host waits for this; until you answer, the lobby stays in the match.

If `forge.your_move` events wake your seat, never call `forge_wait`. Act on what the status shows, then end your turn. Wherever these steps say `forge_wait`, or the prompt reads "Waiting for ...", end your turn. The next event starts a new turn when the seat has to act. A game played by waiting inside one long turn keeps the whole game in one growing context.

`forge_wait` is for a client with no event subscription. Use it instead of calling `forge_status` in a tight loop. It returns as soon as the seat is asked something (a pack, a prompt, a decision, the lobby before you are ready, the end of the game) or another player chats, and not while the opponent acts.

A `forge.chat` event means another player said something. Answer with `forge_chat`, and act only if the prompt is also yours.

## Reading the game state

- `prompt` is the text Forge shows above the buttons, for example "Play spells and abilities, or pass priority" or "Declare attackers". It tells you what the current input wants.
- `buttons.ok` / `buttons.cancel` carry the current labels (OK, Cancel, Done, Pass, Yes, No) and whether each is enabled.
- `players[]` has life, zone sizes, `battlefield`, `graveyard`, and `hand` for your own seat only. Every card has an `id`; actions use it. A card field at its default (untapped, no damage, not attacking) is left out, and the rules text of each card is in `cardText` under the card's name. `forge_game_state {full: true}` puts every field and the text on each card. A battlefield card with `phasedOut: true` is phased out: treat it as though it does not exist until it phases in.
- `stack[]` lists what is waiting to resolve, newest last. If the stack is non-empty and you have priority, Forge is asking whether you respond.
- `combat[]` lists attackers, defenders and blockers while combat is being declared or resolved. When the bridge reports it, `blocked` says whether the attacker is blocked, and a blocker you have chosen shows here before you press OK.
- `selection`, when present, lists the cards the current prompt lets you pick, with `min` and `max`. It includes cards in zones the state does not otherwise show, such as your library during a search. Pick with `selectCard` and the card's `id`. When the prompt can target a player, `selection.players` lists them: pick with `selectPlayer` and the player's `id`. `selection.chosen` lists what you have picked so far. When a prompt requires a fixed number of cards (`min` equals `max`), the pick that reaches `max` answers the prompt by itself: do not press `ok` after it, since that press would land on the next prompt.
- `actionable`, when present, lists the cards (`id`, `name`) the host marks as able to act right now: cards you can play while you have priority, creatures that can attack or block while declaring, mana sources while paying a cost. It is a hint, so a card missing from it may still be usable. It can arrive a moment after the prompt text, so read the state again if a prompt expects a card and the list is missing. If the host refuses a declaration of no blockers, choose a blocker from this list.
- `pendingDecision`, when present, must be answered with `forge_game_decide` before anything else happens. It carries `kind`, `prompt`, `options`, `min`, `max` and sometimes a `default`.

## Taking actions

- Pass priority or confirm: `forge_game_act {action: "ok"}`.
- Decline or back out: `forge_game_act {action: "cancel"}`.
- Play a land or cast a spell: `forge_game_act {action: "selectCard", id}` on a card in your hand while the prompt says you may play spells. Forge then pays costs automatically where it can; if it needs a target it changes the prompt and you `selectCard` or `selectPlayer` again, then `ok`. A Phyrexian mana symbol is paid with 2 life by `selectPlayer` with your own player id, and the prompt then shows the rest of the cost.
- Activate an ability: `selectCard` on the permanent. If it has several abilities a decision dialog lists them.
- Attack: when the prompt says declare attackers, `selectCard` each attacker, then `ok`. `alphaStrike` selects every creature that can attack.
- Block: the prompt names the attacker being blocked, for example "Select creatures to block Archangel (11) or select another attacker to declare blockers for." `selectCard` a blocker to block that attacker. To block another attacker, `selectCard` that attacker first, then its blocker. `ok` when done.
- Optional triggers ("Use triggered ability of Borderland Ranger?") arrive as a prompt with Yes and No buttons, not as a `pendingDecision`. Answer with `forge_game_act` `ok` for yes or `cancel` for no. An optional trigger that needs a target ("you may exile target artifact") can ask for the target first. `cancel` on that target prompt declines the trigger.
- Mulligan, scry, discard, mode choice, ordering triggers: these arrive as `pendingDecision`. Answer with option indices; for `order` kinds give every index in the order you want; for `text`/`number` kinds set `text`. For kind `assign` (combat damage among blockers and the defender, or a divided amount) set `amounts` to one number per option, adding up to the decision's `amount`; `default` shows a legal split.
- Concede: `forge_game_act {action: "concede"}`.
- Without events, `forge_wait` with the last `revision` after an action returns at your next prompt. Act once per change: resending `ok` or `selectCard` while the prompt still reads "Waiting for ..." does nothing useful and floods the host.

## Priority, auto-pass and yielding

The bridge asks the host to pass priority for you on an opponent's turn whenever you have nothing you could play or activate (`autoPass` in the game summary; `autoPassNow` is what the host was last told). On your own turn you get every priority. Declaring attackers and blockers and answering choices are always asked.

- When the prompt reads "Waiting for ...", end your turn. Do not press `ok` on a prompt that is not live: if a `Priority: ...` prompt names a phase other than the summary's `phase`, or `hasPriority` is false, the host has already passed for you.
- The cancel button changes meaning. Labelled "End Turn" it yields until the end of the turn; labelled "Undo" it takes back your last action. It reads "Undo" while a spell you are casting is on the stack, and pressing it then does not end the turn. Read `buttons.cancel` before pressing it.
- Holding an instant on an opponent's turn: you have an available action, so the host offers every priority. Press cancel while it reads "End Turn" at their upkeep. The host interrupts the yield when they cast a spell or attack you, which are the moments to respond. After an interruption the yield is over, so press "End Turn" again once you have responded or declined.
- Cards an opponent reveals appear as a line in `messages`. There is nothing to answer. A card revealed from an opponent's hand can instead arrive as a prompt such as "Looking at cards in Claude's hand", with OK and End Turn, which holds the game until you press `ok`.
- The summary returned straight after `forge_game_decide` or an "Auto" payment can show the previous prompt. If it looks unchanged, read the state again before acting on it.
- Combat damage for a blocked trampler or a creature with several blockers is an `assign` decision. A split that breaks a rule is replaced by the decision's `default`, and a line in `messages` says so.

## Etiquette

Say hello with `forge_chat` when you join. Keep chat short during a game. If you are coaching a human seat rather than playing, read with `forge_game_state` and talk with `forge_chat`; do not act.

## Other servers and references

- Card lookups beyond the oracle text Forge sends: the Scryfall MCP server (`@olaservo/scryfall-mcp-server`, `search` and `fetch` tools).
- Rules questions: the `mtg-rules` skill on this server when present, or the Comprehensive Rules at https://magic.wizards.com/en/rules.
- Limited pick and win-rate data: 17Lands (https://www.17lands.com/).
- Cube lists we draft: CubeCobra (https://cubecobra.com/).
