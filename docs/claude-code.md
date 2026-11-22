# Claude Code

`claude mcp add forge -- node <path>/dist/index.js` adds the server over stdio. The tools work with that alone, and the agent waits with `forge_wait`.

## Waking the agent on its turn

Claude Code 2.1.322 has no MCP Events client, so the `mcp-events` mod in `claude-code-mod/mcp-events` polls `events/poll` and starts a turn when `forge.your_move` fires. It has been run on Claude Code 2.1.322.

Set `FORGE_MCP_PORT` for the server. With it set, the stdio server also serves `/mcp` over HTTP on that port, sharing the same event log, and the mod polls there.

The mod starts a turn only for the session's own server. `forge_status` returns `events.source`, the prefix of the event ids this server process emits, and `events.http`, whether the process serves `/mcp` over HTTP. The mod reads both from the result of each `forge_status` call. It drops an event whose id does not start with that prefix, and it drops every event until `forge_status` has been called. A truncated poll means the server may have restarted, so the prefix is read again from the next `forge_status` call.

Once `events.http` is true, the mod tells the agent in its system prompt to end its turn when the seat has nothing to do and not to call `forge_wait`.

The mod polls one URL. With several sessions on one machine, the first server gets `FORGE_MCP_PORT` and its session is woken by events. The other servers log that the port is taken and report `events.http: false`, and their sessions wait with `forge_wait`.

## Options

- `url`: the endpoint to poll. Default `http://127.0.0.1:3080/mcp`.
- `server`: the server's name in `/mcp`. Default `forge`.
- `events`: event names to follow, separated by commas. Default: every event the server lists with poll delivery.
- `superseded`: event names dropped when the agent has called a state tool since the event. Default `forge.your_move`.
- `stateTools`: the tools whose results show the server's state. Default `forge_status,forge_wait,forge_game_state,forge_game_act,forge_game_decide`.
- `waitTools`: the tools the agent is told not to call. Default `forge_wait`.
- `ownOnly`: start turns only for the session's own server, as above. Default on. Turned off, every event at the URL starts a turn and the system prompt note is added as soon as the mod is polling.
- `statusTool`: the tool whose result has `events.source` and `events.http`. Default `forge_status`.

## Installing the mod

Install the mod for sessions started in a folder with `claude plugin marketplace add <path to this repo> --scope project` and `claude plugin install mcp-events@forge-mcp-server --scope project`, run from that folder; a folder marketplace is read in place, so edits here take effect on `/reload-plugins`. For one session, `claude --plugin-dir <path>/claude-code-mod/mcp-events`. Its test runs with `claude plugin test`.

With `ownOnly` off, do not install it at user scope: every session would poll the one HTTP port, and a second session would be woken by the first one's game.
