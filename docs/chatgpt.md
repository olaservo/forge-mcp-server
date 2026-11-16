# ChatGPT

ChatGPT's MCP Events client uses webhook delivery only ([MCP Events for plugins](https://developers.openai.com/plugins/build/mcp-events), read 2026-11-11). It calls `events/subscribe` with a callback URL and a signing secret, and the server POSTs each event there. [Events](events.md#webhooks) describes the server's side and its settings.

The server follows ChatGPT where it differs from SEP-3415 at `f77a5fe`: `webhook-id` is the event's `eventId`, `events/unsubscribe` of an unknown subscription succeeds, the capability is also declared under the top-level `events` key, and no `gap` or `terminated` envelope is sent.

## Authentication

Webhook subscriptions are offered only when the HTTP endpoint has a bearer token. ChatGPT cannot connect with a bearer token. Its Add custom MCP server form offers OAuth or no authentication, and a packaged plugin whose `mcp.json` declares a bearer token installs without a server connection. The Worker in `worker/` provides the OAuth side: see [Sign-in proxy](sign-in-proxy.md).

## How ChatGPT connects

1. Deploy the Worker. The server has to reach ChatGPT's callback URL over outbound HTTPS.
2. At chatgpt.com/plugins choose Add, Add custom MCP server, enter the Worker's `MCP_RESOURCE_URL`, choose OAuth and sign in with Google. Its page lists the tools and an Events section.
3. In a Work chat on the web, mention the plugin and ask it to subscribe to `forge.your_move` and `forge.chat`. Events do not arrive in ordinary chats, or through an MCP server added in the desktop app's own settings.

## Plugin for the desktop app

`npm run plugin:chatgpt -- --url https://<host>/mcp` writes a local marketplace to `chatgpt-plugin/build` with a `forge-seat` plugin. Installed through `codex plugin marketplace add`, it gives the desktop app the skills only. To carry the server connection it would need an `.app.json` that names the ID of the plugin made in step 2.

## Trials

Tried against ChatGPT on 2026-11-11 with a test build that accepted its unauthenticated connection: it listed 16 tools and both events, subscribed, passed the callback verification, joined a lobby and played two games. In the first game events started its turns with nobody typing. In the second it needed a typed nudge for most turns while the server sent 77 `forge.your_move` events in 16 minutes; whether ChatGPT drops events that arrive while it is working is not established. Telling it to stop made it unsubscribe.

ChatGPT played one game through the Worker on 2026-11-12. [Sign-in proxy](sign-in-proxy.md) has that run.
