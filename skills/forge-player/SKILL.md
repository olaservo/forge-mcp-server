---
name: forge-player
description: Play a Magic match in Forge through the forge_* tools as one seat in a hosted online lobby. Use when connecting to a Forge host, sitting in the lobby, or taking game actions (priority, casting, attacking, blocking, answering choice dialogs). Also lists the other MCP servers and references an agent at the table should attach.
---

# Playing a Forge match

You are one seat in a Forge online lobby. A headless Forge client (the bridge) holds the seat; the tools read what Forge would show on screen and press what a human would click. Forge enforces the rules, so you never need to compute legality: try the action, and if Forge rejects it the answer has `refused: true` and the prompt is unchanged.

## Session loop

1. `forge_status`. If the bridge is down the result says how to start it. When you are asked to host, and nobody has a Forge lobby open, `forge_host` starts one on this machine: connect to it at `127.0.0.1` in the next step, and tell the other players the address and port from its answer. That host starts the match by itself when every seat is ready with a legal deck, and says in chat when it refuses a deck. Choose your deck and your avatar before you ready: the match starts 3 seconds after the last seat is ready. After a match the host waits for the seats to ready again.
2. `forge_connect` with the host's address (default port 36743) and your display name. The host sees you join a lobby slot. To choose your portrait, look at `forge_lobby_avatars` and set one with `forge_lobby_avatar`. If `forge_status` shows you already connected and in a slot, the seat was taken for you (auto-join), possibly under a placeholder name: do not connect again. Set your name with `forge_lobby_name`, then your portrait and deck, then ready up. The forge-name skill has a way to get a fantasy name if you want one.
3. In a Limited lobby after a draft or sealed event, build the deck from your pool with `forge_draft_deck` (the forge-drafter skill has the steps) and check that you are ready. In a constructed lobby, pass a deck `id` from `forge_decks`, or submit `.dck` text. If nobody named a deck, list them and pick one that fits the lobby. Do not say in chat which deck you took. The forge-deck skill covers choosing and importing decks.
4. Know your deck before you ready. `forge_lobby_deck` answers with `cards`: every card of the main deck with its count, cost, type and rules text. Read it once and note how the deck wins, which opening hands to keep, and which cards to hold for the right moment. The game does not send these cards' text again.
5. Ready up with `forge_lobby_ready`. The game starts when every seat is ready.
6. Play until an answer has `gameOver: true`. `winner` then names who won. Each `forge_game_act` and `forge_game_decide` returns what you are asked next and what you need to answer it, so act from that. Read `forge_game_state` when you plan a turn and what you have is not enough, not before every action.
7. Leave with `forge_game_act {action: "quit"}`, or `continue` for the next game of a multi-game match. The host waits for this; until you answer, the lobby stays in the match.

If `forge.your_move` events wake your seat, never call `forge_wait`. When an answer has `waiting: true`, or the prompt reads "Waiting for ...", nothing is asked of you: end your turn. Do not read the state to see whether something has changed. The next event starts a new turn when the seat has to act. A game played by waiting or polling inside one long turn keeps the whole game in one growing context.

A `forge.your_move` event for a game prompt carries what `forge_game_act` would return for it, with the board. Act on it without reading the state first, and pass its `promptCount` as `at`. If the prompt has changed by the time your action arrives, nothing is sent and the answer has `stale: true` with the current prompt.

`forge_wait` is for a client with no event subscription. Use it instead of calling `forge_status` in a tight loop. It returns as soon as the seat is asked something (a pack, a prompt, a decision, the lobby before you are ready, the end of the game) or another player chats, and not while the opponent acts.

A `forge.chat` event means another player said something. Answer with `forge_chat` if an answer is called for. It needs no state read, and you act only if a prompt is also yours.

## What an action returns

A field is left out when it has nothing to say.

- `prompt` is the text Forge shows above the buttons, for example "Declare attackers" or a `Priority:` prompt with the turn, the phase and the stack size. It tells you what the current input wants. `promptCount` goes up with each prompt.
- `buttons` has the labels of the enabled buttons: `ok` (OK, Done, Yes, Auto) and `cancel` (Cancel, No, End Turn, Undo). A button that is not there is disabled.
- `waiting: true`: nothing is asked of you.
- `refused: true`: Forge rejected the action. `stale: true`: the action named an old prompt with `at` and was not sent.
- `life` has each player's life total.
- `hand`, when you have priority: your cards with `id`, `name`, cost and type. Actions use the `id`.
- `stack`, when it is not empty, newest last: who put each item there (`by`), its `source`, its `text` and its `targets`. If the stack is not empty and you have priority, Forge is asking whether you respond.
- `mana`: mana floating in your pool, by colour letter.
- `combat` lists attackers, defenders and blockers while combat is being declared or resolved. `blocked` says whether the attacker is blocked, and a blocker you have chosen shows here before you press OK.
- `selection`, when the prompt lets you pick: the cards (with `min` and `max`) and `players` it offers, including cards in zones you do not otherwise see, such as your library during a search. Pick with `selectCard` and the card's `id`, or `selectPlayer` and the player's `id`. `selection.chosen` lists what you have picked so far. When a prompt requires a fixed number of cards (`min` equals `max`), the pick that reaches `max` answers the prompt by itself: do not press `ok` after it, since that press would land on the next prompt.
- `actionable` lists the cards (`id`, `name`) the host marks as able to act right now: cards you can play while you have priority, creatures that can attack or block while declaring, mana sources while paying a cost. It is a hint, so a card missing from it may still be usable.
- `pendingDecision`, when present, must be answered with `forge_game_decide` before anything else happens. It carries `kind`, `prompt`, `options`, `min`, `max` and sometimes a `default`.
- `board`: each player's battlefield and zone sizes. It comes when an event starts your turn and the first time an action returns your main phase in a turn. A card field at its default (untapped, no damage, not attacking) is left out. A card with `phasedOut: true` is treated as though it does not exist until it phases in. An Aura, Equipment or Fortification has `attachedTo`. A card with `faceDown: true` is a 2/2 with no text to everyone but its controller.
- `cardText` has rules text by card name, only for names this game has not sent you yet. A card carries its own `text` when it differs from its name's, for example a creature that gained an ability. `[inactive]` marks text that does not apply now, such as an ability whose condition is not met.
- `since` has what happened since your last result: `log` lines from the game log (spells cast and resolved, attacks, blocks, damage, life changes, cards changing zones), cards `newInHand`, and `messages`, which includes cards an opponent revealed. Read it before you act: it is how you learn what the opponent did and what you drew.

`forge_game_state` returns the whole game: both battlefields, graveyards, your hand, the stack and combat. `allText: true` sends the text of every card again, for when you no longer have it.

## Taking actions

- Play a land: `forge_game_act {action: "selectCard", id}` on a land in your hand while the prompt says you may play spells.
- Cast a spell: `{action: "selectCard", id, pay: "auto", pass: true}`. `pay: "auto"` lets Forge tap lands for the cost, and `pass: true` then passes priority so the spell resolves. If the spell needs a target, the answer is the target prompt: pick with `selectCard` or `selectPlayer` and give `pay` and `pass` on that call. Leave `pay` out to choose which lands to tap: the pay prompt then lists them in `actionable`, and `ok` reads "Auto". Leave `pass` out to keep priority with your spell on the stack.
- A Phyrexian mana symbol is paid with 2 life by `selectPlayer` with your own player id, and the prompt then shows the rest of the cost.
- Pass priority or confirm: `{action: "ok"}`. With your own spell or ability on top of the stack, `ok` passes until the stack is empty, and the host asks you again as soon as an opponent adds to the stack or attacks. `once: true` passes one time only.
- End your turn: `{action: "endTurn"}`. It passes until the end of the turn, and the host asks you again if an opponent casts a spell or attacks. Do not press `cancel` for this: the Cancel button reads "End Turn" at some prompts and "Undo" at others, also with an empty stack, and Undo takes back your last spell or land.
- Activate an ability: `selectCard` on the permanent. If it has several abilities a decision dialog lists them.
- Attack: you are asked to declare attackers after you pass priority in your main phase with creatures that can attack. `selectCard` each attacker, or `alphaStrike` for every creature that can attack, then `{action: "ok", endTurn: true}` to attack and pass the rest of the turn. Plain `ok` attacks and keeps your stops: after blockers are declared and in your second main phase. `ok` with no attacker chosen attacks with nothing.
- Block: the prompt names the attacker being blocked, for example "Select creatures to block Archangel (11) or select another attacker to declare blockers for." `selectCard` a blocker to block that attacker. To block another attacker, `selectCard` that attacker first, then its blocker. `ok` when done. `ok` with no blocker chosen declares no blocks. If the host refuses a declaration of no blockers, choose a blocker from `actionable`.
- Optional triggers ("Use triggered ability of Borderland Ranger?") arrive when the trigger resolves, as a prompt with Yes and No buttons, not as a `pendingDecision`. Answer with `ok` for yes or `cancel` for no. An optional trigger that needs a target ("you may exile target artifact") can ask for the target first. `cancel` on that target prompt declines the trigger.
- Mulligan, scry, discard, mode choice, ordering triggers: these arrive as `pendingDecision`. Answer with option indices; for `order` kinds give every index in the order you want; for `text`/`number` kinds set `text`. A number such as X can also arrive as kind `choices` with the numbers as options and "Other...": pick the index of your number, or "Other..." for a number prompt. For kind `assign` (combat damage among blockers and the defender, or a divided amount) set `amounts` to one number per option, adding up to the decision's `amount`; `default` shows a legal split.
- Decline or back out of a prompt: `{action: "cancel"}`, when `buttons.cancel` reads Cancel or No.
- Concede: `{action: "concede"}`.
- Without events, `forge_wait` with the last `revision` after an action returns at your next prompt. Act once per change: resending `ok` or `selectCard` while nothing is asked of you does nothing useful and floods the host.

## Where you are asked

The host passes priority for you where a player seldom acts, as Forge does for a person at the desktop client.

- On your own turn, with the stack empty, you are asked in your first main phase, after blockers are declared, and in your second main phase. Your upkeep, draw step, beginning of combat and end step pass by themselves.
- On an opponent's turn you are asked only when you have something you could play or activate (`autoPass` is `opponent-turns`): at beginning of combat, after attackers and after blockers are declared, in the end step, and whenever the opponent puts something on the stack. With nothing to play, their turn passes without a prompt for you.
- Something on the stack is always asked, unless it is your own and you passed with `ok`. Declaring attackers and blockers and answering choices are always asked.
- Holding an instant on an opponent's turn: pass with `ok` at each prompt until the moment you want. `endTurn` there passes the rest of their turn, and the host interrupts it when they cast a spell or attack you.
- A card revealed from an opponent's hand can arrive as a prompt such as "Looking at cards in Claude's hand", with OK, which holds the game until you press `ok`.
- Combat damage for a blocked trampler or a creature with several blockers is an `assign` decision. A split that breaks a rule is replaced by the decision's `default`, and a line in `since.messages` says so.

## Etiquette

Say hello with `forge_chat` when you join. Keep chat short during a game. If you are coaching a human seat rather than playing, read with `forge_game_state` and talk with `forge_chat`; do not act.

## Other servers and references

- Card lookups beyond the oracle text Forge sends: the Scryfall MCP server (`@olaservo/scryfall-mcp-server` 2.1.0 or later), `search` and `fetch` tools.
- Rules questions: the same server. `get_rulings` gives a card's Oracle text and official rulings, `get_rule` looks up a Comprehensive Rules number such as 702.19b, and `search_rules` searches the rules and glossary by keyword. Forge still decides what is legal; use these to understand an interaction or to explain a play in chat, and quote the rule number and its `[cN]` link when you do. Without the server, or when it has no answer, use a web fetch or search tool if you have one: the Comprehensive Rules text file linked from https://magic.wizards.com/en/rules (search it for the rule number or keyword), and a card's rulings from the Scryfall API at `https://api.scryfall.com/cards/named?fuzzy=<name>`, whose `rulings_uri` lists them. Both are plain text or JSON and need no sign-in.
- Limited pick and win-rate data: 17Lands (https://www.17lands.com/).
- Cube lists we draft: CubeCobra (https://cubecobra.com/).
