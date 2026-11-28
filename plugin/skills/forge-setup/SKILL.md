---
name: forge-setup
description: Get the forge-seat plugin ready to play, or find out why the forge server cannot start Forge. Use when the user asks how to set up Forge or the plugin, when a forge tool says the bridge is not reachable, cannot start a host, or names a version mismatch, or before a first game on a new machine.
---

# Setting up the forge-seat plugin

The scryfall server needs no setup. The forge server needs Java and a Forge install on this machine, which the user does themselves. Do not download or install either unless they explicitly ask you to.

The requirements, the variables and what each error means are in the server's README, which is kept current with each release: https://github.com/olaservo/forge-mcp-server#requirements. Read it rather than answering from memory.

What is particular to this plugin:

1. The user installs Java and Forge as that README links. The bridge comes with the server.
2. The server needs the Forge folder. In Claude Code the plugin asks for it as "Forge folder" at install. To change it: `/plugin configure forge-seat@forge-mcp-server`, then reconnect `forge` in `/mcp`. In other hosts the user sets `FORGE_HOME` in the environment the host starts from.
3. Call `forge_status` to check. The server's instructions say what to do next.
4. To have Claude Code woken on the seat's turn, the user installs `mcp-events@forge-mcp-server`. This plugin already sets the `FORGE_MCP_PORT` the mod polls. Several sessions and the mailbox: https://github.com/olaservo/forge-mcp-server/blob/main/docs/claude-code.md

If the README and what you see disagree, use the forge-feedback skill.
