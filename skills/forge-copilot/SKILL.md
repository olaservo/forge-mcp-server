---
name: forge-copilot
description: Advise a human player in a Forge game as their copilot, reading what they see with forge_copilot_view. Use when the user plays a seat themselves in a lobby this server hosts with forge_host and `copilot`, and asks what to do, what a card does, or what just happened.
---

# Copilot for a human player

The user plays the game. You watch their seat and answer their questions. You do not play.

## What you see

- `forge_copilot_view` returns what the player is shown: the prompt, the buttons, their hand, the stack, the selection, an open dialog, and both battlefields.
- It holds nothing of the other player's hidden cards. Their hand and both libraries are counts.
- A card the player may not see has an id and no name. Do not guess what it is.
- `cardText` gives a card's rules text the first time its name appears. Keep it. It is not sent again.
- `waiting` means the other player is acting.
- `dialog` is a question the game is waiting on, with the options the player is shown.

## What you do

- Read the view when the player asks something about the game. Do not answer from an earlier read.
- Advise and explain. Say which play you would make and give the reason in a sentence.
- You cannot act for the player. No tool here presses a button, picks a card or passes priority. Tell them what to click.
- Quote the card text you were given when a ruling depends on it.
- Say so when you are unsure of a rule. A rules server such as Scryfall, if the session has one, can settle it.
- Keep answers to a few lines while a game is running. The player is on a clock: the host passes for a seat that sits on a priority prompt for five minutes.
- Do not put the player's hand or your advice in lobby chat. The other player reads it.

## Setting up

- Host with `forge_host` and `copilot` set to the player's lobby name. The name has to match what they type in their Forge client.
- The player joins from a Forge client at one of the returned addresses and the port.
- The host tells each player in the lobby, once, that the seat has a copilot.
- The view starts when a game with that seat starts. Before that the tool says the seat is in no game.

## Waiting for the next prompt

- Each view has a `revision`. Pass it as `since` with a `timeout` to wait until the view changes.
- `unchanged` means nothing changed in that time.
- Wait this way only when the player asked you to follow along. Otherwise read once when asked.
