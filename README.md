# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge)) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

This project is independent. It is not affiliated with, endorsed by or sponsored by Card-Forge, Wizards of the Coast or Hasbro. Magic: The Gathering is a trademark of Wizards of the Coast LLC. The card names and card text in the test fixtures were recorded from Forge and belong to Wizards of the Coast.

## Requirements

This repo is one of three parts. Cloning it alone is not enough to play.

- **Forge and the agent bridge.** The server talks to a headless Forge client, the agent bridge, which is not part of Forge. It is a small jar from [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge) (GPL-3.0) that runs beside a Forge desktop jar, built against the Forge version you run. Set `FORGE_JAR`, `FORGE_HOME` and `FORGE_BRIDGE_JAR` and the server starts it.
- **A Forge host.** Someone hosts an online lobby in a Forge desktop client and the agent joins it as an ordinary remote player. Tested with a host running the same build. An upstream build of the same version should work as the host, since the network protocol is upstream's, but that has not been tried.
- **Node 22 or newer** for this server, and an MCP client that speaks protocol revision 2026-07-28. The skills are served through the MCP skills extension, so a client without it will not load them by itself.

To have the agent woken on its turn in Claude Code, also install the `mcp-events` mod from `claude-code-mod/mcp-events` and set `FORGE_MCP_PORT` (see Run). It has been run on Claude Code 2.1.322. While it is polling, the mod tells the agent in its system prompt to end its turn when the seat has nothing to do and not to call `forge_wait`. Without the mod the tools still work, and the agent waits with `forge_wait`.

## Pieces

- **Bridge** (Java, [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge)): a jar that runs beside the Forge jar. Boots the card database headless and serves `GET /status`, `GET /wait`, `POST /connect`, `POST /lobby/ready`, `POST /lobby/avatar`, `POST /lobby/deck`, `POST /chat`, `GET /draft/pack`, `POST /draft/pick`, `GET /draft/pool`, `GET /game`, `GET /game/log`, `POST /game/act`, `POST /game/decide` on `127.0.0.1:36744`.
- **This server** (TypeScript): tools `forge_status`, `forge_connect`, `forge_disconnect`, `forge_lobby_ready`, `forge_lobby_avatars`, `forge_lobby_avatar`, `forge_lobby_deck`, `forge_chat`, `forge_draft_pack`, `forge_draft_pick`, `forge_draft_pool`, `forge_game_state`, `forge_game_log`, `forge_game_act`, `forge_game_decide`, `forge_wait`, and the deck tools `forge_decks` and `forge_deck_save` (see Decks); resources `forge://status`, `forge://game/log`, `forge://draft/pool`; skills `forge-player`, `forge-drafter` and `forge-deck` served through the MCP skills extension. Every tool declares an `outputSchema` (`src/schemas.ts`) and returns `structuredContent`. A watcher long-polls the bridge and pushes `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers (on stdio through the server, on HTTP through the handler's event bus), so a client that subscribes does not need `forge_wait`.
- **Events**: `events/list` and `events/poll` from [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) (Accepted by the Core Maintainers on 2026-11-11, not yet merged; read at `f77a5fe`), declared as `capabilities.extensions["io.modelcontextprotocol/events"]` and registered as custom methods in `src/events.ts` because SDK 2.4.0 has no events support. Two event types, delivered by poll, and by webhook when the HTTP endpoint has a token (see ChatGPT below). The watcher emits `forge.your_move` when the seat's pending ask changes: a draft pick, a priority prompt, a choice dialog, or the end of a game. It emits `forge.chat` for each chat line from another player. Events are kept in memory (1000 entries), cursors are per process, and a cursor from before a restart polls as `truncated`. No push (`events/stream`) delivery yet.

## Run

Build Forge once (`mvn -U -B clean -P windows-linux install -DskipTests` in a Forge checkout) and build the bridge jar against it, as the [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge) README describes. Then set three variables and the server starts the bridge on first use:

- `FORGE_JAR`: the Forge `forge-gui-desktop-<version>-jar-with-dependencies.jar`.
- `FORGE_BRIDGE_JAR`: the bridge jar.
- `FORGE_HOME`: the folder that holds Forge's `res/`, which is `forge-gui` in a checkout.

Loading cards takes about 40 s. To start the bridge yourself, follow its README. The server looks for it at `FORGE_BRIDGE_URL` (default `http://127.0.0.1:36744`).

Then:

```
npm install
npm run build
npm start                 # stdio
npm run start:http        # Streamable HTTP on http://127.0.0.1:3080/mcp (FORGE_MCP_HOST, FORGE_MCP_PORT, FORGE_MCP_ALLOWED_HOSTS)
```

Claude Code: `claude mcp add forge -- node <path>/dist/index.js`.

With `FORGE_MCP_PORT` set, the stdio server also serves `/mcp` over HTTP on that port, sharing the same event log. Claude Code 2.1.322 has no MCP Events client, so the `mcp-events` mod in `claude-code-mod/mcp-events` polls `events/poll` there and starts a turn when `forge.your_move` fires.

Install the mod for sessions started in a folder with `claude plugin marketplace add <path to this repo> --scope project` and `claude plugin install mcp-events@forge-mcp-server --scope project`, run from that folder; a folder marketplace is read in place, so edits here take effect on `/reload-plugins`. For one session, `claude --plugin-dir <path>/claude-code-mod/mcp-events`. Its test runs with `claude plugin test`. Do not install it at user scope: every session would poll the one HTTP port, and a second session would be woken by the first one's game.

## Decks

`forge_decks` lists the decks in Forge's folders on the server's machine, and `forge_lobby_deck` takes a deck `id` from that list. `forge_deck_save` writes a new deck into the folder it belongs in. The three tools read and write files and do not need the bridge. The `forge-deck` skill tells an agent how to use them.

Folders. Under the user's deck folder: `constructed`, `commander`, `brawl`, `oathbreaker`, `tiny_leaders`, `network-events`, `draft`, `sealed`, `net`. Under `FORGE_HOME/res`: `precons` (`quest/precons`), `commander-precons` (`quest/commanderprecons`), `quest-duels` (`quest/duels`) and `cube`. The user's deck folder is found the way Forge finds it: `decksDir` or `userDir` in `FORGE_HOME/forge.profile.properties`, else `%APPDATA%\Forge` on Windows, `~/Library/Application Support/Forge` on macOS and `~/.forge` elsewhere. `FORGE_USER_DIR` and `FORGE_DECKS_DIR` override it.

`forge_deck_save` takes a deck page URL or deck text. Text can be Forge `.dck`, a plain list with or without Arena or Magic Online headings and set codes, or a Magic Online `.dek` file. Card names are checked against Forge's card scripts in `FORGE_HOME/res/cardsfolder` and rewritten to the name Forge uses; a deck with a card Forge does not implement is not saved unless `allowUnknown` is set. The folder follows from the deck: a commander or a Commander format goes to `commander`, a cube to `res/cube` with a `res/draft/<name>.draft` definition, a pool with event tags to `network-events`, anything else to `constructed`. An existing file is replaced only with `overwrite`. Set `FORGE_DECKS_READONLY=1` to leave `forge_deck_save` out.

Sites, each checked on 2026-11-13 by fetching one public deck, converting it and loading the result in Forge 2.0.16 with no card missing:

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

`FORGE_HOME=<forge folder> npm run check:decks` repeats the check against the live sites: it fetches a sample deck from each and reports any card Forge does not have. `--out <dir>` also writes the converted `.dck` files. The first listing that filters by `query` or `colors` reads every deck file once; with 27,000 files that took 11 s here, and later calls about 1 s.

## ChatGPT

ChatGPT's MCP Events client uses webhook delivery only ([MCP Events for plugins](https://developers.openai.com/plugins/build/mcp-events), read 2026-11-11). It calls `events/subscribe` with a callback URL and a signing secret, and the server POSTs each event there. `src/webhooks.ts` implements `events/subscribe` and `events/unsubscribe` from SEP-3415: the verification handshake, Standard Webhooks signatures, retries (4 attempts, none after 410 or 413), secret rotation, and callback addresses checked when the socket connects. Events are not replayable over webhook, so every cursor is `null`.

The server follows ChatGPT where it differs from the SEP at `f77a5fe`: `webhook-id` is the event's `eventId`, `events/unsubscribe` of an unknown subscription succeeds, the capability is also declared under the top-level `events` key, and no `gap` or `terminated` envelope is sent.

Webhook subscriptions need an authenticated caller, so they are offered only when `FORGE_MCP_TOKEN` or `FORGE_MCP_PROXY_TOKEN` is set. Every request to `/mcp` must then carry `Authorization: Bearer <token>`.

ChatGPT cannot connect with that token. Its Add custom MCP server form offers OAuth or no authentication, and a packaged plugin whose `mcp.json` declares a bearer token installs without a server connection. The Worker in `worker/` provides the OAuth side (see Sign-in proxy below).

Other settings:

- The HTTP server logs one line to stderr for each subscribe, unsubscribe and delivery attempt, with the callback's status and the time it took, and one line for each tool call by an authenticated caller.
- `FORGE_MCP_LOG`: a file that gets those lines instead of stderr, plus one line for each event emitted, each `events/poll` that returns events, and each tool call on stdio or HTTP. Use it to see when an event was emitted, when a polling client picked it up, and when the seat acted.
- `FORGE_MCP_SUBSCRIPTIONS`: a JSON file that keeps subscriptions across restarts. It holds the signing secrets. Without it subscriptions live in memory, last an hour by default (a day at most), and a request for no expiry gets a day.
- `FORGE_MCP_WEBHOOK_INSECURE=1`: allow `http` callbacks and non-public addresses, for a receiver on the same machine.
- `FORGE_MCP_ALLOWED_HOSTS`: add the public host name the server is reached under.

How ChatGPT connects:

1. Deploy the Worker. The server has to reach ChatGPT's callback URL over outbound HTTPS.
2. At chatgpt.com/plugins choose Add, Add custom MCP server, enter the Worker's `MCP_RESOURCE_URL`, choose OAuth and sign in with Google. Its page lists the tools and an Events section.
3. In a Work chat on the web, mention the plugin and ask it to subscribe to `forge.your_move` and `forge.chat`. Events do not arrive in ordinary chats, or through an MCP server added in the desktop app's own settings.

`npm run plugin:chatgpt -- --url https://<host>/mcp` writes a local marketplace to `chatgpt-plugin/build` with a `forge-seat` plugin. Installed through `codex plugin marketplace add`, it gives the desktop app the two skills only. To carry the server connection it would need an `.app.json` that names the ID of the plugin made in step 2.

Tried against ChatGPT on 2026-11-11 with a test build that accepted its unauthenticated connection: it listed 16 tools and both events, subscribed, passed the callback verification, joined a lobby and played two games. In the first game events started its turns with nobody typing. In the second it needed a typed nudge for most turns while the server sent 77 `forge.your_move` events in 16 minutes; whether ChatGPT drops events that arrive while it is working is not established. Telling it to stop made it unsubscribe.

## Sign-in proxy

`worker/` is a Cloudflare Worker that puts the server behind Google sign-in. It is an OAuth authorization server for MCP clients (`@cloudflare/workers-oauth-provider`: dynamic registration, client ID metadata documents, a consent page), it accepts only the Google accounts in `ALLOWED_EMAILS`, and it forwards `/mcp` to the server. The server stays on the machine that runs Forge.

The Worker replaces the caller's token with `FORGE_MCP_PROXY_TOKEN` and sets `x-forge-principal: google:<sub>`. The server takes the principal from that header only on a request that carries the proxy token, and webhook subscriptions are keyed on it. `FORGE_MCP_TOKEN` is not needed beside it.

Setup, from `worker/`:

1. Google Cloud Console: an OAuth client of type Web application, redirect URI `https://<worker host>/callback`. Consent screen in Testing is enough; add each allowed account as a test user.
2. `npm install`, `npx wrangler login`, and copy `wrangler.example.jsonc` to `wrangler.jsonc`. The copy holds your host name and resource ids and is not committed. Then `npx wrangler kv namespace create forge-seat-oauth` and paste the id into it.
3. Set `MCP_RESOURCE_URL` in `wrangler.jsonc` to the deployed endpoint, `https://forge-seat.<account>.workers.dev/mcp`.
4. Give the Worker a route to the server. Either a [Workers VPC](https://developers.cloudflare.com/workers-vpc/) service (beta): `npx wrangler tunnel create forge-seat`, `npx wrangler tunnel run forge-seat` on the server's machine, `npx wrangler vpc service create forge-seat --type http --tunnel-id <id> --ipv4 127.0.0.1 --http-port 3080`, and uncomment `vpc_services` in `wrangler.jsonc`. Or a named Cloudflare Tunnel with a public host name: set `ORIGIN_URL` to `https://<tunnel host>` and add that host to `FORGE_MCP_ALLOWED_HOSTS`.
5. Secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` (comma-separated, lowercase) and `ORIGIN_TOKEN` (the server's `FORGE_MCP_PROXY_TOKEN`, 32+ random characters). Optional `CONSENT_SECRET` (32+ random characters) remembers an approved client for 30 days.
6. `npm run deploy`, and start the server with `FORGE_MCP_PROXY_TOKEN` set.

`npm run dev` serves the Worker on `http://localhost:8788` from a `.dev.vars` file; copy `.dev.vars.example`. Sign-in is fail-closed: an empty `ALLOWED_EMAILS` rejects everyone. The allow-list is checked again on every request to `/mcp`, so taking an account off it stops that account's existing tokens. Dynamic client registration is open, as MCP clients expect: anyone can register a client and reach the consent page, and nobody gets a token without an allowed Google account.

Deployed once, on 2026-11-12, with a Workers VPC service on `127.0.0.1`. Checked: the Worker's forwarding against the server in `test/worker-forward.test.ts`, and on the deployed Worker a client that registered itself, signed in with Google and called `initialize`, `tools/list` and `events/list` through the VPC route. ChatGPT connected with OAuth and subscribed to both events, each stored under the principal `google:<sub>` after the callback verification. ChatGPT played one game through the Worker on 2026-11-12. All 40 webhook deliveries got 200 and it renewed its subscriptions before they expired. The seat played unprompted for five minutes and then needed typed nudges. The cause is not established.

## Test

`npm test` runs an in-process MCP client against the server with a fake bridge, including a `subscriptions/listen` round trip. `test/webhooks.test.ts` covers webhook delivery, checks the signatures with the `standardwebhooks` package, and runs one subscription over real sockets behind a token. `test/fixtures.test.ts` checks every tool's output schema against real bridge payloads in `test/fixtures/`, then runs all 18 tools over them. `test/decks.test.ts` covers the deck tools against a small Forge folder built in a temp directory: the card index, each text form, each site's parser over a trimmed recording of its real response in `test/fixtures/decks/`, and the folder and overwrite rules. The fixtures are recorded by the bridge's own tests, which host a draft and a match in-process and write its responses to `target/agent-fixtures` in forge-agent-bridge. Copy them over after a bridge change.

## Status

Lobby, draft and full matches work end to end. The bridge's tests run a draft and a match against an in-process host, and on 2026-11-11 the agent seat played three Constructed matches against a human host in the Forge desktop client on the same machine, woken by events. Not yet run across machines. Skills are first drafts.

## Security

The HTTP endpoint has no authentication unless `FORGE_MCP_TOKEN` is set. It binds to `127.0.0.1` by default. Without a token, do not set `FORGE_MCP_HOST` to an address reachable from outside a network you trust: anyone who can reach the port can act as the seat. With a token, anyone who holds it can act as the seat, and the token is the only credential, so serve it over HTTPS only. The same holds for `FORGE_MCP_PROXY_TOKEN`, and its holder can also name any principal, so only the Worker should have it.

Whoever can call the tools can also read the deck files in Forge's folders and, through `forge_deck_save`, write `.dck` files into them and make the server fetch from the deck sites listed above. File names are stripped of path characters and deck ids are confined to their folder. `FORGE_DECKS_READONLY=1` removes the saving tool.

## License

MIT. Copyright (c) 2026 Carbon-Based Content LLC. See [LICENSE](LICENSE).
