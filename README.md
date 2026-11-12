# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, `java -jar forge...jar agent`) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

This project is independent. It is not affiliated with, endorsed by or sponsored by Card-Forge, Wizards of the Coast or Hasbro. Magic: The Gathering is a trademark of Wizards of the Coast LLC. The card names and card text in the test fixtures were recorded from Forge and belong to Wizards of the Coast.

## Requirements

This repo is one of three parts. Cloning it alone is not enough to play.

- **A custom build of Forge.** The server talks to a headless Forge client, the agent bridge, which is not in upstream Forge. It lives in the `master` branch of the fork [olaservo/forge](https://github.com/olaservo/forge), package `forge.agent`. Building it needs a JDK (17 or newer) and Maven, and takes about 15 minutes.
- **A Forge host.** Someone hosts an online lobby in a Forge desktop client and the agent joins it as an ordinary remote player. Tested with a host running the same build. An upstream build of the same version should work as the host, since the network protocol is upstream's, but that has not been tried.
- **Node 22 or newer** for this server, and an MCP client that speaks protocol revision 2026-07-28. The skills are served through the MCP skills extension, so a client without it will not load them by itself.

To have the agent woken on its turn in Claude Code, also install the `mcp-events` mod from `claude-code-mod/mcp-events` and set `FORGE_MCP_PORT` (see Run). It has been run on Claude Code 2.1.322. Without the mod the tools still work, and the agent waits with `forge_wait`.

## Pieces

- **Bridge** (Java, in the Forge fork, `master` of `olaservo/forge`): console mode `agent` in `forge-gui-desktop`, package `forge.agent`. Boots the card database headless and serves `GET /status`, `GET /wait`, `POST /connect`, `POST /lobby/ready`, `POST /lobby/avatar`, `POST /lobby/deck`, `POST /chat`, `GET /draft/pack`, `POST /draft/pick`, `GET /draft/pool`, `GET /game`, `GET /game/log`, `POST /game/act`, `POST /game/decide` on `127.0.0.1:36744`.
- **This server** (TypeScript): tools `forge_status`, `forge_connect`, `forge_disconnect`, `forge_lobby_ready`, `forge_lobby_avatars`, `forge_lobby_avatar`, `forge_lobby_deck`, `forge_chat`, `forge_draft_pack`, `forge_draft_pick`, `forge_draft_pool`, `forge_game_state`, `forge_game_log`, `forge_game_act`, `forge_game_decide`, `forge_wait`; resources `forge://status`, `forge://game/log`, `forge://draft/pool`; skills `forge-player` and `forge-drafter` served through the MCP skills extension. Every tool declares an `outputSchema` (`src/schemas.ts`) and returns `structuredContent`. A watcher long-polls the bridge and pushes `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers (on stdio through the server, on HTTP through the handler's event bus), so a client that subscribes does not need `forge_wait`.
- **Events**: `events/list` and `events/poll` from [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) (Accepted by the Core Maintainers on 2026-11-11, not yet merged; read at `f77a5fe`), declared as `capabilities.extensions["io.modelcontextprotocol/events"]` and registered as custom methods in `src/events.ts` because SDK 2.4.0 has no events support. Two event types, poll delivery only. The watcher emits `forge.your_move` when the seat's pending ask changes: a draft pick, a priority prompt, a choice dialog, or the end of a game. It emits `forge.chat` for each chat line from another player. Events are kept in memory (1000 entries), cursors are per process, and a cursor from before a restart polls as `truncated`. No push (`events/stream`) or webhook delivery yet.

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

## Test

`npm test` runs an in-process MCP client against the server with a fake bridge, including a `subscriptions/listen` round trip, and `test/fixtures.test.ts` checks every tool's output schema against real bridge payloads in `test/fixtures/`, then runs all 16 tools over them. The fixtures are recorded by the Java tests (`BridgeHttp.saveFixtures`, written to `forge-gui-desktop/target/agent-fixtures`); copy them over after a bridge change. The Java side has `AgentDraftTest` and `AgentGameTest` in `forge-gui-desktop/src/test/java/forge/agent/`: the first hosts a two-seat draft in-process and lets the bridge take the second seat, the second hosts a Limited match against the AI and lets the bridge play it to the end with a pass-or-first-option policy.

## Status

Lobby, draft and full matches work end to end. The Java tests run a draft and a match against an in-process host, and on 2026-11-11 the agent seat played three Constructed matches against a human host in the Forge desktop client on the same machine, woken by events. Not yet run across machines. Skills are first drafts.

## Security

The HTTP endpoint has no authentication. It binds to `127.0.0.1` by default. Do not set `FORGE_MCP_HOST` to an address reachable from outside a network you trust: anyone who can reach the port can act as the seat.

## License

MIT. Copyright (c) 2026 Carbon-Based Content LLC. See [LICENSE](LICENSE).
