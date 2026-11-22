# forge-mcp-server

MCP server that gives an agent a seat in a [Forge](https://github.com/Card-Forge/forge) network draft or match. It talks to a headless Forge client (the agent bridge, [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge)) over a loopback HTTP API and exposes the seat as MCP tools, resources and skills. Protocol revision 2026-07-28, TypeScript SDK v2.

This project is independent. It is not affiliated with, endorsed by or sponsored by Card-Forge, Wizards of the Coast or Hasbro. Magic: The Gathering is a trademark of Wizards of the Coast LLC. The card names and card text in the test fixtures were recorded from Forge and belong to Wizards of the Coast.

## Requirements

This repo is one of three parts. Cloning it alone is not enough to play.

- **Forge and the agent bridge.** The server talks to a headless Forge client, the agent bridge, which is not part of Forge. It is a small jar from [forge-agent-bridge](https://github.com/olaservo/forge-agent-bridge) (GPL-3.0) that runs beside a Forge desktop jar, built against the Forge version you run. Its [releases](https://github.com/olaservo/forge-agent-bridge/releases) have a jar for the Forge 2.0.16 desktop release. Set `FORGE_JAR`, `FORGE_HOME` and `FORGE_BRIDGE_JAR` and the server starts it.
- **A Forge host.** Someone hosts an online lobby in a Forge desktop client and the agent joins it as an ordinary remote player. The host runs the same Forge version as the bridge. Played against a host on the official Forge 2.0.16 desktop release, with the bridge jar built against it. Without a desktop host, `forge_host` starts one with no window on the server's machine; see [Hosting](#hosting).
- **Node 24 or newer** for this server, and an MCP client that speaks protocol revision 2026-07-28. The skills are served through the MCP skills extension, so a client without it will not load them by itself.

## Run

Download the [Forge 2.0.16 desktop release](https://github.com/Card-Forge/forge/releases/tag/forge-2.0.16) and `forge-agent-bridge-0.1.6-forge-2.0.16.jar` from the [forge-agent-bridge releases](https://github.com/olaservo/forge-agent-bridge/releases). The events need bridge 0.1.3 or later. From 0.1.4 the bridge marks the priority prompt, and before it the server matches the prompt's English text. From 0.1.5 a chat line names its sender, and before it the server splits the line on the seat names. `forge_draft_deck`, the pick clock's `secondsLeft` and the end of the `deck` ask once a deck is built need 0.1.6. With an older bridge the `deck` ask stays pending after a deck is set. For another Forge version, build the bridge jar against that version's jar, as the forge-agent-bridge README describes. Then set three variables and the server starts the bridge on first use:

- `FORGE_JAR`: the Forge `forge-gui-desktop-<version>-jar-with-dependencies.jar`.
- `FORGE_BRIDGE_JAR`: the bridge jar.
- `FORGE_HOME`: the folder that holds Forge's `res/`. That is the unpacked folder for a release download and `forge-gui` in a checkout.

Loading cards takes about 40 s. Each server process starts a bridge of its own on a free loopback port and stops it on exit, so two agent sessions on one machine hold two seats. `forge_status` shows the URL as `bridge.url`.

To start the bridge yourself, follow its README and set `FORGE_BRIDGE_URL` to its address, for example `http://127.0.0.1:36744`. The server then uses the bridge at that URL, and starts one there only when nothing answers. Every server with the same `FORGE_BRIDGE_URL` drives the same seat. The repo owner's own `.mcp.json` sets `FORGE_BRIDGE_URL`, and that line has to be removed there to get one bridge per session.

Auto-join is off unless `FORGE_AUTO_JOIN` is set to the host's `host:port`, for example `127.0.0.1:36743`. The server then starts the bridge at start-up, and the bridge takes the first Open slot of each lobby that appears there, with no tool call. `FORGE_AUTO_JOIN_NAME` is the seat name (default `Agent`). `FORGE_AUTO_JOIN_DECK` is the path of a `.dck` file, or the name of a deck in the profile's `constructed` or `network-events` folder. A relative path is read from `FORGE_HOME`, so a deck that ships with Forge works on any install, for example `res/quest/precons/Azorius Advance.dck`. With a deck the seat also readies, and without one the agent sets a deck and readies. The variables apply only to a bridge this server starts. Leave it off when another player is joining, and see the bridge README for when it tries again.

Then:

```
npm install
npm run build
npm start                 # stdio
npm run start:http        # Streamable HTTP on http://127.0.0.1:3080/mcp (FORGE_MCP_HOST, FORGE_MCP_PORT, FORGE_MCP_ALLOWED_HOSTS)
```

`node scripts/call.mjs <tool> '<json arguments>'` calls one tool on a server running over HTTP and prints the result, and `node scripts/call.mjs --poll forge.your_move [cursor]` polls an event. `FORGE_MCP_URL` names the endpoint.

Claude Code: `claude mcp add forge -- node <path>/dist/index.js`. To have the agent woken on its turn, also install the `mcp-events` mod, as [Claude Code](docs/claude-code.md) describes. Without the mod the agent waits with `forge_wait`.

## Hosting

`forge_host` starts the bridge jar's `MatchHost`, a Forge host with no window and no seat of its own, and `forge_host_stop` ends it. It needs bridge 0.1.7 or later and the same three variables. Every slot is open: the agent takes a seat with `forge_connect` at `127.0.0.1`, and other players join from a Forge desktop or mobile client at one of the addresses the tool returns. The match starts once every slot is taken and each seat is ready with a legal deck. Arguments are `port` (default 36743), `seats` (default 2) and `limited` for 40-card decks. One host per server process, stopped when the server stops. `FORGE_HOSTING=0` removes both tools.

A seat with `FORGE_AUTO_JOIN` set to the hosted port sits down by itself, and so does every other seat on the machine with the same setting, so host on another port when a slot is meant for someone else. Run on 2026-11-21 with one bridge seat joining a host started by the tool. A Forge client as the other player has not been run.

## More

- [Decks](docs/decks.md): the deck tools, the folders they read, and the deck sites `forge_deck_save` can fetch from and `forge_deck_search` can search.
- [Events](docs/events.md): `forge.your_move` and `forge.chat` over MCP Events, by poll or webhook, and the settings for both.
- [Claude Code](docs/claude-code.md): the `mcp-events` mod that starts a turn when an event fires.
- [ChatGPT](docs/chatgpt.md): connecting ChatGPT, which takes events by webhook and signs in with OAuth.
- [Sign-in proxy](docs/sign-in-proxy.md): the Cloudflare Worker in `worker/` that puts the server behind Google sign-in.

## Test

`npm test` runs an in-process MCP client against the server with a fake bridge, including a `subscriptions/listen` round trip. `test/events.test.ts` covers poll and push delivery. `test/webhooks.test.ts` covers webhook delivery, checks the signatures with the `standardwebhooks` package, and runs one subscription over real sockets behind a token. `test/fixtures.test.ts` checks every tool's output schema against real bridge payloads in `test/fixtures/`, then runs every tool over them. `test/decks.test.ts` covers the deck tools against a small Forge folder built in a temp directory: the card index, each text form, each site's parser over a trimmed recording of its real response in `test/fixtures/decks/`, and the folder and overwrite rules. The fixtures are recorded by the bridge's own tests, which host a draft and a match in-process and write its responses to `target/agent-fixtures` in forge-agent-bridge. Copy them over after a bridge change.

## Status

Lobby, draft and full matches work end to end. The bridge's tests run a draft and a match against an in-process host, on 2026-11-21 a seat drafted a four-seat pod through this server over HTTP against the bridge's windowless `DraftHost`, built its deck with `forge_draft_deck` and was started into the match, and on 2026-11-11 the agent seat played three Constructed matches against a human host in the Forge desktop client on the same machine, woken by events. Not yet run across machines. Skills are first drafts.

## Security

The HTTP endpoint has no authentication unless `FORGE_MCP_TOKEN` is set. It binds to `127.0.0.1` by default. Without a token, do not set `FORGE_MCP_HOST` to an address reachable from outside a network you trust: anyone who can reach the port can act as the seat. With a token, anyone who holds it can act as the seat, and the token is the only credential, so serve it over HTTPS only. The same holds for `FORGE_MCP_PROXY_TOKEN`, and its holder can also name any principal, so only the Worker should have it.

Whoever can call the tools can also read the deck files in Forge's folders and, through `forge_deck_save`, write `.dck` files into them and make the server fetch from the deck sites listed in [Decks](docs/decks.md#sites). `forge_deck_search` makes it send search requests to three of those sites. File names are stripped of path characters and deck ids are confined to their folder. `FORGE_DECKS_READONLY=1` removes both tools.

Whoever can call the tools can also start a Forge host with `forge_host`. It listens on every network interface of the server's machine with no password, so anyone who can reach that port can take a seat in the lobby. `FORGE_HOSTING=0` removes it.

## License

MIT. Copyright (c) 2026 Carbon-Based Content LLC. See [LICENSE](LICENSE).
