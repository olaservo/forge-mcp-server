# Decks

`forge_decks` lists the decks in Forge's folders on the server's machine, and `forge_lobby_deck` takes a deck `id` from that list. `forge_deck_save` writes a new deck into the folder it belongs in. The three tools read and write files and do not need the bridge. The `forge-deck` skill tells an agent how to use them.

## Folders

Under the user's deck folder: `constructed`, `commander`, `brawl`, `oathbreaker`, `tiny_leaders`, `network-events`, `draft`, `sealed`, `net`. Under `FORGE_HOME/res`: `precons` (`quest/precons`), `commander-precons` (`quest/commanderprecons`), `quest-duels` (`quest/duels`) and `cube`. The user's deck folder is found the way Forge finds it: `decksDir` or `userDir` in `FORGE_HOME/forge.profile.properties`, else `%APPDATA%\Forge` on Windows, `~/Library/Application Support/Forge` on macOS and `~/.forge` elsewhere. `FORGE_USER_DIR` and `FORGE_DECKS_DIR` override it.

`net` can hold tens of thousands of decks (35,830 here after downloading every category Forge lists), so it is listed only with `folder: "net"`, and a `query` there matches the category and file name so that only matching files are read. A `colors` filter on `net` without a `query` reads every net deck once.

## Saving a deck

`forge_deck_save` takes a deck page URL or deck text. Text can be Forge `.dck`, a plain list with or without Arena or Magic Online headings and set codes, or a Magic Online `.dek` file. Card names are checked against Forge's card scripts in `FORGE_HOME/res/cardsfolder` and rewritten to the name Forge uses; a deck with a card Forge does not implement is not saved unless `allowUnknown` is set. The folder follows from the deck: a commander or a Commander format goes to `commander`, a cube to `res/cube` with a `res/draft/<name>.draft` definition, a pool with event tags to `network-events`, anything else to `constructed`. An existing file is replaced only with `overwrite`. Set `FORGE_DECKS_READONLY=1` to leave `forge_deck_save` out.

A saved deck's file is named the way Forge names it (`DeckBase.getBestFileName`: the deck name without `/ : * ? " < > |`). When Forge starts, it moves any file in the top of `constructed` that is named otherwise up into the decks folder, where no deck screen reads it, and deletes one it cannot parse (`DeckStorage.adjustFileLocation`, read at `bdcce440b7c`; the move was observed here on 2026-11-13).

## Sites

Each was checked on 2026-11-13 by fetching one public deck, converting it and loading the result in Forge 2.0.16 with no card missing:

| Site | Fetched from |
|---|---|
| Moxfield | `api2.moxfield.com/v3/decks/all/<id>` |
| Archidekt | `archidekt.com/api/decks/<id>/` |
| AetherHub | `aetherhub.com/Deck/FetchMtgaDeckJson?deckId=<id>` |
| EDHREC average decks | `json.edhrec.com/pages/average-decks/<commander>.json` |
| MTGTop8 | `mtgtop8.com/mtgo?d=<id>` |
| MTGDecks | the deck page's Arena export |
| Cube Cobra | `cubecobra.com/cube/download/forge/<id>` |

MTGGoldfish and TappedOut answered 403 with a Cloudflare challenge to every request tried, so the tool asks for the deck's text export instead. Moxfield, AetherHub and MTGDecks answered 403 to Node's `fetch` and 200 to `node:https` with the same headers, so the fetcher uses `node:https`. None of these endpoints is a documented API. The fetcher sends one or two requests per deck, to these hosts only, over HTTPS.

`FORGE_HOME=<forge folder> npm run check:decks` repeats the check against the live sites: it fetches a sample deck from each and reports any card Forge does not have. `--out <dir>` also writes the converted `.dck` files.
