---
name: forge-player
description: Play a Magic match in Forge through the forge_* tools as one seat in a hosted online lobby. Use when connecting to a Forge host, sitting in the lobby, or taking game actions (priority, casting, attacking, blocking, answering choice dialogs). Also lists the other MCP servers and references an agent at the table should attach.
---

# Playing a Forge match

You are one seat in a Forge online lobby. A headless Forge client (the bridge) holds the seat; the tools read what Forge would show on screen and press what a human would click. Forge enforces the rules, so you never need to compute legality: try the action, and if Forge rejects it `incorrectActions` goes up and the prompt is unchanged.

## Session loop

1. `forge_status`. If the bridge is down the result says how to start it.
2. `forge_connect` with the host's address (default port 36743) and your display name. The host sees you join a lobby slot.
3. In a Limited lobby, `forge_lobby_deck` (no arguments uses the pool you drafted) then `forge_lobby_ready`. In a constructed lobby, name a deck from Forge's deck folders or submit `.dck` text.
4. Wait with `forge_wait` (pass the last `revision`) until `game.inGame` is true.
5. Play: alternate `forge_game_state` and one action until `game.finished`.

Use `forge_wait` instead of calling `forge_status` in a tight loop. It returns as soon as a pack, a prompt or a decision appears.

## Reading the game state

- `prompt` is the text Forge shows above the buttons, for example "Play spells and abilities, or pass priority" or "Declare attackers". It tells you what the current input wants.
- `buttons.ok` / `buttons.cancel` carry the current labels (OK, Cancel, Done, Pass, Yes, No) and whether each is enabled.
- `players[]` has life, zone sizes, `battlefield`, `graveyard`, and `hand` for your own seat only. Every card has an `id`; actions use it.
- `stack[]` lists what is waiting to resolve, newest last. If the stack is non-empty and you have priority, Forge is asking whether you respond.
- `combat[]` lists attackers, defenders and blockers while combat is being declared or resolved.
- `pendingDecision`, when present, must be answered with `forge_game_decide` before anything else happens. It carries `kind`, `prompt`, `options`, `min`, `max` and sometimes a `default`.

## Taking actions

- Pass priority or confirm: `forge_game_act {action: "ok"}`.
- Decline or back out: `forge_game_act {action: "cancel"}`.
- Play a land or cast a spell: `forge_game_act {action: "selectCard", id}` on a card in your hand while the prompt says you may play spells. Forge then pays costs automatically where it can; if it needs a target it changes the prompt and you `selectCard` or `selectPlayer` again, then `ok`.
- Activate an ability: `selectCard` on the permanent. If it has several abilities a decision dialog lists them.
- Attack: when the prompt says declare attackers, `selectCard` each attacker, then `ok`. `alphaStrike` selects every creature that can attack.
- Block: when the prompt says declare blockers, `selectCard` the blocker then `selectCard` the attacker it blocks; `ok` when done.
- Mulligan, scry, discard, mode choice, ordering triggers: these arrive as `pendingDecision`. Answer with option indices; for `order` kinds give every index in the order you want; for `text`/`number` kinds set `text`.
- Concede: `forge_game_act {action: "concede"}`.

Forge auto-yields through phases where you have nothing to do only if the host has that setting; otherwise expect a priority prompt at every step and press `ok` through it.

## Etiquette

Say hello with `forge_chat` when you join. Keep chat short during a game. If you are coaching a human seat rather than playing, read with `forge_game_state` and talk with `forge_chat`; do not act.

## Other servers and references

- Card lookups beyond the oracle text Forge sends: the Scryfall MCP server (`@olaservo/scryfall-mcp-server`, `search` and `fetch` tools).
- Rules questions: the `mtg-rules` skill on this server when present, or the Comprehensive Rules at https://magic.wizards.com/en/rules.
- Limited pick and win-rate data: 17Lands (https://www.17lands.com/).
- Cube lists we draft: CubeCobra (https://cubecobra.com/).
