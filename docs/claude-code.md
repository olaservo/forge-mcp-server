# Claude Code

`claude mcp add forge -- node <path>/dist/index.js` adds the server over stdio. The tools work with that alone, and the agent waits with `forge_wait`.

## Waking the agent on its turn

Claude Code 2.1.322 has no MCP Events client, so the `mcp-events` mod in `claude-code-mod/mcp-events` polls `events/poll` and starts a turn when `forge.your_move` fires. It has been run on Claude Code 2.1.322.

Set `FORGE_MCP_PORT` for the server. With it set, the stdio server also serves `/mcp` over HTTP on that port, sharing the same event log, and the mod polls there.

While it is polling, the mod tells the agent in its system prompt to end its turn when the seat has nothing to do and not to call `forge_wait`.

## Installing the mod

Install the mod for sessions started in a folder with `claude plugin marketplace add <path to this repo> --scope project` and `claude plugin install mcp-events@forge-mcp-server --scope project`, run from that folder; a folder marketplace is read in place, so edits here take effect on `/reload-plugins`. For one session, `claude --plugin-dir <path>/claude-code-mod/mcp-events`. Its test runs with `claude plugin test`.

Do not install it at user scope: every session would poll the one HTTP port, and a second session would be woken by the first one's game.
