# forge-seat plugin

Draft and play Magic: The Gathering in a Forge online lobby, with Scryfall card and rules lookup. The plugin starts two MCP servers with `npx`, `forge` (`@olaservo/forge-mcp-server`) and `scryfall` (`@olaservo/scryfall-mcp-server`), at their latest versions.

It is laid out for two plugin formats that share `skills/`: [Agent Plugins](https://agent-plugins.org/) (`plugin.json`, `mcp.json`) and Claude Code (`.claude-plugin/plugin.json`, `.mcp.json`). Claude Code asks for the Forge folder at install. Other hosts read `FORGE_HOME` from the environment.

## Install

Claude Code: `/plugin marketplace add olaservo/forge-mcp-server`, then `/plugin install forge-seat@forge-mcp-server`. Add `mcp-events@forge-mcp-server` to have the agent woken on its turn.

You need Java and Forge, as the server's [requirements](../README.md#requirements) describe. The `forge-setup` skill covers what is particular to the plugin and links there for the rest.

## Skills

`skills/` holds only skills that no server serves. The forge server serves its own skills (forge-player, forge-drafter and the others) over MCP, so they are not copied here. A host that should read them as local files instead can get them from the server's repo and set `FORGE_SKILLS=0` on the server, which stops it serving them.
