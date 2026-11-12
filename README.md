# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, `java -jar forge...jar agent`) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

This project is independent. It is not affiliated with, endorsed by or sponsored by Card-Forge, Wizards of the Coast or Hasbro. Magic: The Gathering is a trademark of Wizards of the Coast LLC. The card names and card text in the test fixtures were recorded from Forge and belong to Wizards of the Coast.

## Requirements

This repo is one of three parts. Cloning it alone is not enough to play.

- **Forge and the agent bridge.** The server talks to a headless Forge client, the agent bridge, which is not part of Forge. It is a small jar from [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge) (GPL-3.0) that runs beside a Forge desktop jar, built against the Forge version you run. Set `FORGE_JAR`, `FORGE_HOME` and `FORGE_BRIDGE_JAR` and the server starts it. The same classes are also in the `master` branch of the fork [olaservo/forge](https://github.com/olaservo/forge), where the bridge is the `agent` mode of the Forge jar.
- **A Forge host.** Someone hosts an online lobby in a Forge desktop client and the agent joins it as an ordinary remote player. Tested with a host running the same build. An upstream build of the same version should work as the host, since the network protocol is upstream's, but that has not been tried.
- **Node 22 or newer** for this server, and an MCP client that speaks protocol revision 2026-07-28. The skills are served through the MCP skills extension, so a client without it will not load them by itself.

To have the agent woken on its turn in Claude Code, also install the `mcp-events` mod from `claude-code-mod/mcp-events` and set `FORGE_MCP_PORT` (see Run). It has been run on Claude Code 2.1.322. Without the mod the tools still work, and the agent waits with `forge_wait`.

## Pieces

- **Bridge** (Java, in the Forge fork, `master` of `olaservo/forge`): console mode `agent` in `forge-gui-desktop`, package `forge.agent`. Boots the card database headless and serves `GET /status`, `GET /wait`, `POST /connect`, `POST /lobby/ready`, `POST /lobby/avatar`, `POST /lobby/deck`, `POST /chat`, `GET /draft/pack`, `POST /draft/pick`, `GET /draft/pool`, `GET /game`, `GET /game/log`, `POST /game/act`, `POST /game/decide` on `127.0.0.1:36744`.
- **This server** (TypeScript): tools `forge_status`, `forge_connect`, `forge_disconnect`, `forge_lobby_ready`, `forge_lobby_avatars`, `forge_lobby_avatar`, `forge_lobby_deck`, `forge_chat`, `forge_draft_pack`, `forge_draft_pick`, `forge_draft_pool`, `forge_game_state`, `forge_game_log`, `forge_game_act`, `forge_game_decide`, `forge_wait`; resources `forge://status`, `forge://game/log`, `forge://draft/pool`; skills `forge-player` and `forge-drafter` served through the MCP skills extension. Every tool declares an `outputSchema` (`src/schemas.ts`) and returns `structuredContent`. A watcher long-polls the bridge and pushes `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers (on stdio through the server, on HTTP through the handler's event bus), so a client that subscribes does not need `forge_wait`.
- **Events**: `events/list` and `events/poll` from [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) (Accepted by the Core Maintainers on 2026-11-11, not yet merged; read at `f77a5fe`), declared as `capabilities.extensions["io.modelcontextprotocol/events"]` and registered as custom methods in `src/events.ts` because SDK 2.4.0 has no events support. Two event types, delivered by poll, and by webhook when the HTTP endpoint has a token (see ChatGPT below). The watcher emits `forge.your_move` when the seat's pending ask changes: a draft pick, a priority prompt, a choice dialog, or the end of a game. It emits `forge.chat` for each chat line from another player. Events are kept in memory (1000 entries), cursors are per process, and a cursor from before a restart polls as `truncated`. No push (`events/stream`) delivery yet.

## Run

Clone [olaservo/forge](https://github.com/olaservo/forge) and build it once (`mvn -U -B clean -P windows-linux install -DskipTests`), then start the bridge from the `forge-gui` folder so it finds `res/`:

```
cd forge-gui
java -Djava.awt.headless=true -Dfile.encoding=UTF-8 -Xmx2048m -jar ../forge-gui-desktop/target/forge-gui-desktop-2.0.16-SNAPSHOT-jar-with-dependencies.jar agent --port 36744
```

It prints `AGENT_BRIDGE_READY port=36744` after loading cards (about 40 s). Alternatively set `FORGE_JAR` (path to that jar) and `FORGE_HOME` (the `forge-gui` folder) and the server starts the bridge itself on first use. With `FORGE_BRIDGE_JAR` also set to a [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge) jar, the server runs that jar beside the Forge jar, and `FORGE_JAR` can be an unmodified Forge build.

Then:

```
npm install
npm run build
npm start                 # stdio
npm run start:http        # Streamable HTTP on http://127.0.0.1:3080/mcp (FORGE_MCP_HOST, FORGE_MCP_PORT, FORGE_MCP_ALLOWED_HOSTS)
```

Claude Code: `claude mcp add forge -- node <path>/dist/index.js`. Environment: `FORGE_BRIDGE_URL` (default `http://127.0.0.1:36744`). With `FORGE_MCP_PORT` set, the stdio server also serves `/mcp` over HTTP on that port, sharing the same event log. Claude Code 2.1.322 has no MCP Events client, so the `mcp-events` mod in `claude-code-mod/mcp-events` polls `events/poll` there and starts a turn when `forge.your_move` fires. Install it for sessions started in a folder with `claude plugin marketplace add <path to this repo> --scope project` and `claude plugin install mcp-events@forge-mcp-server --scope project`, run from that folder; a folder marketplace is read in place, so edits here take effect on `/reload-plugins`. For one session, `claude --plugin-dir <path>/claude-code-mod/mcp-events`. Its test runs with `claude plugin test`. Do not install it at user scope: every session would poll the one HTTP port, and a second session would be woken by the first one's game.

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

Deployed once, on 2026-11-12, with a Workers VPC service on `127.0.0.1`. Checked: the Worker's forwarding against the server in `test/worker-forward.test.ts`, and on the deployed Worker a client that registered itself, signed in with Google and called `initialize`, `tools/list` and `events/list` through the VPC route. ChatGPT connected with OAuth and subscribed to both events, each stored under the principal `google:<sub>` after the callback verification. Not yet run: a game played by ChatGPT through the Worker.

## Test

`npm test` runs an in-process MCP client against the server with a fake bridge, including a `subscriptions/listen` round trip. `test/webhooks.test.ts` covers webhook delivery, checks the signatures with the `standardwebhooks` package, and runs one subscription over real sockets behind a token. And `test/fixtures.test.ts` checks every tool's output schema against real bridge payloads in `test/fixtures/`, then runs all 16 tools over them. The fixtures are recorded by the Java tests (`BridgeHttp.saveFixtures`, written to `forge-gui-desktop/target/agent-fixtures`); copy them over after a bridge change. The Java side has `AgentDraftTest` and `AgentGameTest` in `forge-gui-desktop/src/test/java/forge/agent/`: the first hosts a two-seat draft in-process and lets the bridge take the second seat, the second hosts a Limited match against the AI and lets the bridge play it to the end with a pass-or-first-option policy.

## Status

Lobby, draft and full matches work end to end. The Java tests run a draft and a match against an in-process host, and on 2026-11-11 the agent seat played three Constructed matches against a human host in the Forge desktop client on the same machine, woken by events. Not yet run across machines. Skills are first drafts.

## Security

The HTTP endpoint has no authentication unless `FORGE_MCP_TOKEN` is set. It binds to `127.0.0.1` by default. Without a token, do not set `FORGE_MCP_HOST` to an address reachable from outside a network you trust: anyone who can reach the port can act as the seat. With a token, anyone who holds it can act as the seat, and the token is the only credential, so serve it over HTTPS only. The same holds for `FORGE_MCP_PROXY_TOKEN`, and its holder can also name any principal, so only the Worker should have it.

## License

MIT. Copyright (c) 2026 Carbon-Based Content LLC. See [LICENSE](LICENSE).
