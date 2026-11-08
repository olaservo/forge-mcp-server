# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, `java -jar forge...jar agent`) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

Not affiliated with Card-Forge or Wizards of the Coast.

## Pieces

- **Bridge** (Java, in the Forge fork on branch `personal/agent-bridge`): console mode `agent` in `forge-gui-desktop`, package `forge.agent`. Boots the card database headless and serves `GET /status`, `GET /wait`, `POST /connect`, `POST /lobby/ready`, `POST /lobby/deck`, `POST /chat`, `GET /draft/pack`, `POST /draft/pick`, `GET /draft/pool`, `GET /game`, `GET /game/log`, `POST /game/act`, `POST /game/decide` on `127.0.0.1:36744`.
- **This server** (TypeScript): tools `forge_status`, `forge_connect`, `forge_disconnect`, `forge_lobby_ready`, `forge_lobby_deck`, `forge_chat`, `forge_draft_pack`, `forge_draft_pick`, `forge_draft_pool`, `forge_game_state`, `forge_game_log`, `forge_game_act`, `forge_game_decide`, `forge_wait`; resources `forge://status`, `forge://game/log`, `forge://draft/pool`; skills `forge-player` and `forge-drafter` served through the MCP skills extension.

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

Claude Code: `claude mcp add forge -- node <path>/dist/index.js`. Environment: `FORGE_BRIDGE_URL` (default `http://127.0.0.1:36744`).

## Test

`npm test` runs an in-process MCP client against the server with a fake bridge. The Java side has `AgentDraftTest` in `forge-gui-desktop/src/test/java/forge/agent/`, which hosts a two-seat draft in-process and lets the bridge take the second seat.

## Status

Phase 1 of the plan in the goldmind notes (`research/mtg/forge-mcp-server-plan.md`): lobby and draft work end to end against an in-process host. Game actions and decisions are wired but untested against a live match. Skills are first drafts.
