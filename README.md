# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, `java -jar forge...jar agent`) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

Not affiliated with Card-Forge or Wizards of the Coast.

## Pieces

- **Bridge** (Java, in the Forge fork, `master` of `olaservo/forge`): console mode `agent` in `forge-gui-desktop`, package `forge.agent`. Boots the card database headless and serves `GET /status`, `GET /wait`, `POST /connect`, `POST /lobby/ready`, `POST /lobby/avatar`, `POST /lobby/deck`, `POST /chat`, `GET /draft/pack`, `POST /draft/pick`, `GET /draft/pool`, `GET /game`, `GET /game/log`, `POST /game/act`, `POST /game/decide` on `127.0.0.1:36744`.
- **This server** (TypeScript): tools `forge_status`, `forge_connect`, `forge_disconnect`, `forge_lobby_ready`, `forge_lobby_avatars`, `forge_lobby_avatar`, `forge_lobby_deck`, `forge_chat`, `forge_draft_pack`, `forge_draft_pick`, `forge_draft_pool`, `forge_game_state`, `forge_game_log`, `forge_game_act`, `forge_game_decide`, `forge_wait`; resources `forge://status`, `forge://game/log`, `forge://draft/pool`; skills `forge-player` and `forge-drafter` served through the MCP skills extension. Every tool declares an `outputSchema` (`src/schemas.ts`) and returns `structuredContent`. A watcher long-polls the bridge and pushes `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers (on stdio through the server, on HTTP through the handler's event bus), so a client that subscribes does not need `forge_wait`.
- **Events** (experimental): `events/list` and `events/poll` from [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415) (read at `b08e4f9`; error codes provisional), declared as `capabilities.extensions["io.modelcontextprotocol/events"]` and registered as custom methods in `src/events.ts` because SDK 2.4.0 has no events support. Two event types, poll delivery only. The watcher emits `forge.your_move` when the seat's pending ask changes: a draft pick, a priority prompt, a choice dialog, or the end of a game. It emits `forge.chat` for each chat line from another player. Events are kept in memory (1000 entries), cursors are per process, and a cursor from before a restart polls as `truncated`. No push (`events/stream`) or webhook delivery yet.

## Run

Build the Forge fork once (`mvn -U -B clean -P windows-linux install -DskipTests`), then start the bridge from the `forge-gui` folder so it finds `res/`:

```
cd forge-gui
java -Djava.awt.headless=true -Dfile.encoding=UTF-8 -Xmx2048m -jar ../forge-gui-desktop/target/forge-gui-desktop-2.0.16-SNAPSHOT-jar-with-dependencies.jar agent --port 36744
```

It prints `AGENT_BRIDGE_READY port=36744` after loading cards (about 40 s). Alternatively set `FORGE_JAR` (path to that jar) and `FORGE_HOME` (the `forge-gui` folder) and the server starts the bridge itself on first use.

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

Phase 2 of the plan in the goldmind notes (`research/mtg/forge-mcp-server-plan.md`): lobby, draft and a full match work end to end against an in-process host. Not yet exercised against a live desktop host or over the LAN. Skills are first drafts.
