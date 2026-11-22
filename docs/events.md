# Events

An agent can wait for the seat's next ask in three ways: by calling `forge_wait`, by subscribing to `forge://status`, or through MCP Events.

A watcher long-polls the bridge and pushes `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers (on stdio through the server, on HTTP through the handler's event bus), so a client that subscribes does not need `forge_wait`. The same watcher emits the events below.

## MCP Events

`events/list`, `events/poll` and `events/stream` from [SEP-3415](https://modelcontextprotocol.io/seps/3415-events-extension) (Final, merged 2026-11-19), declared as `capabilities.extensions["io.modelcontextprotocol/events"]` and registered as custom methods in `src/events.ts` because SDK 2.4.0 has no events support.

There are two event types:

- `forge.your_move` is emitted when the seat's pending ask changes: a seat in the lobby that is not ready, a draft pick, a drafted or sealed pool with no deck built from it yet (`deck`), a priority prompt, a choice dialog, or the end of a game. It is not emitted while the seat waits on another player, including the moment when Forge has sent the next prompt's buttons and not yet its text. A client's first poll is told the ask that is pending then.
- `forge.chat` is emitted for each chat line from another player.

Both are delivered by poll and push, and by webhook when the HTTP endpoint has a token. Events are kept in memory (1000 entries), cursors are per process, and a cursor from before a restart polls as `truncated`. Over HTTP, a 2026-07-28 request that names an event must carry the same name in the `Mcp-Name` header, or it gets 400 `HeaderMismatch` (`-32020`).

[Claude Code](claude-code.md) describes the mod that polls for Claude Code, and [ChatGPT](chatgpt.md) describes webhook delivery to ChatGPT.

## Push

`events/stream` holds the request open and sends `notifications/events/active`, then each event as `notifications/events/event` with the cursor after it, and `notifications/events/heartbeat` when nothing else has been sent for `heartbeatMs`. The heartbeat interval is 30 s by default, and a client's suggestion is held between 1 s and 55 s. A stream that names a cursor first gets the retained events after it. A stream without one gets the pending ask, as a first poll does. The stream ends when the client aborts the request on HTTP or sends `notifications/cancelled` on stdio.

## Webhooks

`src/webhooks.ts` implements `events/subscribe` and `events/unsubscribe` from SEP-3415: the verification handshake, Standard Webhooks signatures, retries (4 attempts by default, none after 410 or 413), secret rotation, and callback addresses checked when the socket connects. A delivery that is given up on is counted in `deliveryStatus.abandoned` until a refresh has returned it, and `lastError` and `failedSince` stay set until then. A 410, a 413 and a body over 256 KiB count. The `cursor` in each payload and in the subscribe result is the SEP's watermark: every event at or before it has been delivered to that subscription or given up on. A new or lapsed subscription that names a cursor gets the retained events after it, so a client recovers a lost event by `events/unsubscribe` and then `events/subscribe` with its saved cursor. A refresh of a live subscription replays nothing. Its result has `truncated: true` when a delivery was abandoned since the last refresh, or when the cursor is not a position in this process's log, as after a restart. A subscribe after a lapse or an unsubscribe is `truncated` too when an abandoned event lies at or before its cursor. A new subscription to `forge.your_move` is sent the event that reported the pending ask, with its original `eventId`, unless its cursor is past that event. A refresh is not sent it, and neither is a subscription read from `FORGE_MCP_SUBSCRIPTIONS` after a restart. The server follows ChatGPT in the places where ChatGPT differs from the SEP, listed in [ChatGPT](chatgpt.md).

Webhook subscriptions need an authenticated caller, so they are offered only when `FORGE_MCP_TOKEN` or `FORGE_MCP_PROXY_TOKEN` is set. Every request to `/mcp` must then carry `Authorization: Bearer <token>`.

## Settings

- The HTTP server logs one line to stderr for each subscribe, unsubscribe and delivery attempt, with the callback's status and the time it took, and one line for each tool call by an authenticated caller.
- `FORGE_MCP_LOG`: a file that gets those lines instead of stderr, plus one line for each event emitted, each `events/poll` that returns events, and each tool call on stdio or HTTP. Use it to see when an event was emitted, when a polling client picked it up, and when the seat acted.
- `FORGE_MCP_SUBSCRIPTIONS`: a JSON file that keeps subscriptions across restarts. It holds the signing secrets. Without it subscriptions live in memory, last an hour by default (a day at most), and a request for no expiry gets a day.
- `FORGE_MCP_WEBHOOK_RETRY_MS`: the waits before the second and later attempts of a delivery, in ms, separated by commas. The default is `1000,5000,25000`.
- `FORGE_MCP_WEBHOOK_INSECURE=1`: allow `http` callbacks and non-public addresses, for a receiver on the same machine.
- `FORGE_MCP_ALLOWED_HOSTS`: add the public host name the server is reached under.
