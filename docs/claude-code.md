# Claude Code

`claude mcp add forge -- node <path>/dist/index.js` adds the server over stdio. The tools work with that alone, and the agent waits with `forge_wait`.

## Waking the agent on its turn

Claude Code 2.1.322 has no MCP Events client, so the `mcp-events` mod in `claude-code-mod/mcp-events` polls `events/poll` and starts a turn when `forge.your_move` fires. It has been run on Claude Code 2.1.322.

Set `FORGE_MCP_PORT` for the server. With it set, the stdio server also serves `/mcp` over HTTP on that port, sharing the same event log, and the mod polls there.

The mod starts a turn only for the session's own server. `forge_status` returns `events.source`, the prefix of the event ids this server process emits, and `events.http`, whether the process serves `/mcp` over HTTP. The mod reads both from the result of each `forge_status` call. It drops an event whose id does not start with that prefix, and it drops every event until `forge_status` has been called. A truncated poll means the server may have restarted, so the prefix is read again from the next `forge_status` call.

Once `events.http` is true, the mod tells the agent in its system prompt to end its turn when the seat has nothing to do and not to call `forge_wait`.

## Several sessions on one machine

The first server gets `FORGE_MCP_PORT`. Each later one binds a free port on `127.0.0.1`. Every server reports its address as `events.url` in `forge_status` and writes it to a registry, one file per process: `~/.forge-seat/servers/<pid>.json`, or the directory in `FORGE_MCP_REGISTRY`. The file has `url`, `source`, `pid`, `startedAt` and `token`, and `forge_status` gives its path as `events.registry`. The server deletes it on exit, and each server deletes the files of processes that have ended when it starts.

Each process makes up a token for its own life and writes it to its registry file as `token`. With `FORGE_MCP_TOKEN` set, every endpoint needs that token or the process's own. Without it, the server at `FORGE_MCP_PORT` has no authentication, as before, and a server on a free port needs its own token. A port the configuration did not name is never open without one. Webhook subscriptions are offered to a caller that sends a token, so a client on the same machine can subscribe with the one in the file. The file and a directory the server creates are readable by the user only.

The mod polls one URL and sends no token, so on its own it reaches only the server at that URL. A session whose server reports another `events.url` keeps `forge_wait`. To wake every session, run a reader that subscribes to each server in the registry and serves all their events at one address ([mcp-mailbox](https://github.com/olaservo/mcp-mailbox) has one), point the mod's `url` at it and turn `relay` on. The mod still starts a turn only for the session's own events.

`FORGE_MCP_SUBSCRIPTIONS` is read only by the server that got `FORGE_MCP_PORT`. A server on a free port keeps its subscriptions in memory.

## Options

- `url`: the endpoint to poll. Default `http://127.0.0.1:3080/mcp`.
- `server`: the server's name in `/mcp`. Default `forge`.
- `events`: event names to follow, separated by commas. Default: every event the server lists with poll delivery.
- `superseded`: event names dropped when the agent has called a state tool since the event. The first poll of each after the mod loads sends no cursor, so the server sends the ask pending then, however long it has waited. Default `forge.your_move`.
- `stateTools`: the tools whose results show the server's state. A name written `tool:kind` counts only for events whose data has that `kind`, so a lobby tool drops a held lobby event and not a game prompt. Default `forge_status,forge_connect,forge_wait,forge_game_state,forge_game_act,forge_game_decide,forge_lobby_ready:lobby,forge_lobby_deck:lobby,forge_lobby_name:lobby,forge_lobby_avatar:lobby`.
- `waitTools`: the tools the agent is told not to call. Default `forge_wait`.
- `ownOnly`: start turns only for the session's own server, as above. Default on. The prefix is kept in the session's state, so a `/reload-plugins` keeps it until the status tool reports another. Turned off, every event at the URL starts a turn and the system prompt note is added as soon as the mod is polling.
- `statusTool`: the tool whose result has `events.source`, `events.http` and `events.url`. Default `forge_status`.
- `relay`: the endpoint is a reader that relays every server's events, so the session is woken whatever `events.url` its server reports. Default off.

## Installing the mod

Install the mod for sessions started in a folder with `claude plugin marketplace add <path to this repo> --scope project` and `claude plugin install mcp-events@forge-mcp-server --scope project`, run from that folder; a folder marketplace is read in place, so edits here take effect on `/reload-plugins`. For one session, `claude --plugin-dir <path>/claude-code-mod/mcp-events`. Its test runs with `claude plugin test`.

With `ownOnly` off, do not install it at user scope: every session would poll the one HTTP port, and a second session would be woken by the first one's game.
