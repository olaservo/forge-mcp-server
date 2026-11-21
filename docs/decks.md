# Decks

`forge_decks` lists the decks in Forge's folders on the server's machine, and `forge_lobby_deck` takes a deck `id` from that list. `forge_deck_save` writes a new deck into the folder it belongs in, and `forge_deck_search` finds decks on deck sites to save. The four tools do not need the bridge. The `forge-deck` skill tells an agent how to use them.

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

`FORGE_HOME=<forge folder> npm run check:decks` repeats the check against the live sites: it fetches a sample deck from each and reports any card Forge does not have, then runs one search on each site below. `--out <dir>` also writes the converted `.dck` files.

## Searching

`forge_deck_search` asks the sites that have a search and returns each site's results in the site's own order, with a URL `forge_deck_save` takes. It saves nothing. `FORGE_DECKS_READONLY=1` leaves it out along with `forge_deck_save`, so that setting stops every request to the deck sites.

| Site | Request | Matches |
|---|---|---|
| MTGTop8 | `GET mtgtop8.com/search?deck_titre=<query>&format=<code>` | Deck name. When none matches, `cards=<query>` for decks that play the card |
| AetherHub | `POST aetherhub.com/Meta/FetchMetaListAdv?formatId=<n>` with the body its deck table sends | Deck or user name, updated in the last 365 days. When none matches, decks that play the card |
| EDHREC | `GET edhrec.com/api/typeahead/?q=<query>`, then `json.edhrec.com/pages/commanders/<commander>.json` for a theme | Commander name, with up to two trailing words read as a theme of the first commander found |

Each answered a request from `node:https` on 2026-11-21. None is a documented API. `mtgtop8.com/robots.txt` sets `Crawl-delay: 5`, so a MTGTop8 search request waits until 5 seconds after the one before it. A search sends one to three requests per site. An AetherHub request for fewer than 5 rows came back empty, so the server asks for the site's page size of 40 and cuts the list.

The other sites `forge_deck_save` reads are not searched. Archidekt's terms forbid automated searches. Cube Cobra's `robots.txt` disallows `/search`. Moxfield's terms page needs a browser and has not been read. MTGDecks has no text search for decks. The `forge-deck` skill sends an agent to a browser or to web search for those.
