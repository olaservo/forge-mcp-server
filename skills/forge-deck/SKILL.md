---
name: forge-deck
description: Choose a deck for a Forge lobby from Forge's own deck folders, and bring new decks into Forge from deck sites or pasted lists through forge_decks and forge_deck_save. Use when a lobby needs a deck and none was named, when asked what decks are available, or when asked to find, import, download, convert or save a deck or cube for Forge.
---

# Decks for a Forge seat

Forge keeps decks as `.dck` files in folders on the machine the server runs on. Three tools work on them and none needs a connection to a host:

- `forge_decks` lists and reads decks.
- `forge_lobby_deck` with a deck `id` brings one to the lobby.
- `forge_deck_save` writes a new deck into the right folder, from a deck page URL or from text.

## Choosing a deck for the lobby

1. Call `forge_decks` with no arguments. `folders` shows what exists and how much.
2. Narrow it: `folder`, `query` (words from the deck name, the net deck category or the commander) and `colors` (exact colours, `WU`; empty string for colourless).
3. To look inside a deck before choosing, call `forge_decks` with its `id`.
4. `forge_lobby_deck` with the `id`, then `forge_lobby_ready`.

When nobody named a deck, pick one that fits the lobby and say in chat which one you took. Match the lobby's variant first:

| Lobby | Folders | Size to expect |
|---|---|---|
| Constructed | `constructed`, `precons`, `quest-duels`, and `net` when asked for | 60 main |
| Commander | `commander`, `commander-precons` | 99 main and a commander |
| Brawl, Oathbreaker, Tiny Leaders | the folder of that name | |
| Limited | none: `forge_lobby_deck` with no arguments plays the pool you drafted | 40 main |

A `network-events` deck is a draft or sealed pool. Forge delivers a pool with every card in the sideboard, so `main` is 0 until a deck has been built from it. `draft` holds one folder per local draft, with `human` and the AI decks. `quest-duels` are Forge's quest opponents and vary a lot in strength; their `description` says what they do.

Prefer the players' own decks (`constructed`, `commander`) when they ask for "one of ours", and a precon for a fair, quick game. `net` has thousands of decks in category folders such as `Budget Magic` and `Pro Tour`. It is left out of a listing unless you pass `folder: "net"`, and there `query` matches the category and the file name, not the commander. Add `colors` only with a `query`: colours alone make the server read every net deck, which takes a while the first time.

## Bringing in a new deck

`forge_deck_save` takes one of:

- `url`: a deck page on a site in the table below. The server fetches and converts it.
- `text`: the deck itself, in any of the forms under "Text forms".

It checks every card name against the cards this Forge implements and rewrites each to Forge's spelling: front face only for double-faced and adventure cards, `Fire // Ice` for split cards, the real name for a flavour-named printing. Then it picks the folder and writes the file. Read the result:

- `saved: true` and an `id`: done. `forge_lobby_deck` takes the id straight away. Forge's own deck screens show the deck after Forge restarts.
- `unknown` not empty: Forge does not implement those cards, or the names are misspelt. Nothing was written. Fix the names and save again, or pass `allowUnknown` to save the deck without them and tell the player which cards are missing.
- A note that the name is taken: pass another `name`, or `overwrite` if the player wants the old deck replaced.

Use `dryRun` first when the player wants to see what a link holds before anything is written.

Sets are kept when the source names one that Forge knows, so the deck shows the same printings.

### Sites

| Site | URL to pass | Notes |
|---|---|---|
| Moxfield | `https://moxfield.com/decks/<id>` | Commanders, companions and signature spells go to the right sections |
| Archidekt | `https://archidekt.com/decks/<number>/<name>` | Cards in a Maybeboard category are left out |
| AetherHub | `https://aetherhub.com/Deck/<name>-<number>` | |
| EDHREC | `https://edhrec.com/average-decks/<commander>` or `/commanders/<commander>` | The average deck for that commander |
| MTGTop8 | `https://mtgtop8.com/event?e=<event>&d=<deck>` | Tournament lists |
| MTGDecks | `https://mtgdecks.net/<Format>/<name>-decklist-by-<player>-<number>` | Tournament lists |
| Cube Cobra | `https://cubecobra.com/cube/overview/<id>` | Saved as a cube with a draft definition |
| MTGGoldfish, TappedOut | none | They turn away requests that do not come from a browser. Ask the player to open the deck, use the site's download or export, and paste the text. Pass that as `text`. |

To find a deck, search the web for the archetype and a site name, show the player a few links, and save the one they choose. For any other site, get the deck as text.

The server reads the data these sites' own pages load, one or two requests per deck. None of it is a documented API. If a site starts answering with an error, fall back to pasted text.

### Text forms

- A plain list, one card per line: `4 Lightning Bolt`, `4x Lightning Bolt`. A blank line starts the sideboard. One or two cards alone at the end of a 100-card list are the commander.
- Arena and Magic Online exports: `Deck`, `Sideboard`, `Commander` and `Companion` headings, set codes as `(M10) 146` or `[M10]`, and an `About` block with the name.
- A Magic Online `.dek` file (XML).
- A Forge `.dck` file, saved as it is with the names checked.
- A cube list with no counts, one name per line.

Text without a name needs `name`. Text does not say its format, so pass `format` when the folder depends on it: `commander`, `brawl`, `oathbreaker`, `tiny leaders` or `cube`. A list with a Commander section goes to `commander` without it.

### Where decks go

| Deck | Folder |
|---|---|
| Has a commander, or `format` is a Commander variant | `commander` |
| Brawl, Oathbreaker, Tiny Leaders | `brawl`, `oathbreaker`, `tiny_leaders` |
| Cube | `cube`, inside the Forge install, with `res/draft/<name>.draft` so it appears in the draft screens |
| A pool with event tags in its metadata | `network-events` |
| Anything else | `constructed` |

`folder` overrides the choice. `subfolder` files a deck under a folder such as `Modern` inside `constructed`, or a category inside `net`. Decks in a subfolder are found by `forge_decks`, but Forge's `name` lookup in `forge_lobby_deck` only sees the top of `constructed` and `network-events`, so pass the `id`.

## What the check covers

`forge_deck_save` checks that Forge implements every card. It does not check deck size, copies per card or format legality. Compare `main`, `sideboard` and `commander` in the result with what the lobby's format needs before you ready up.
