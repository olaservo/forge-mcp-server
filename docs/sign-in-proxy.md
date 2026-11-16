# Sign-in proxy

`worker/` is a Cloudflare Worker that puts the server behind Google sign-in. It is an OAuth authorization server for MCP clients (`@cloudflare/workers-oauth-provider`: dynamic registration, client ID metadata documents, a consent page), it accepts only the Google accounts in `ALLOWED_EMAILS`, and it forwards `/mcp` to the server. The server stays on the machine that runs Forge.

The Worker replaces the caller's token with `FORGE_MCP_PROXY_TOKEN` and sets `x-forge-principal: google:<sub>`. The server takes the principal from that header only on a request that carries the proxy token, and webhook subscriptions are keyed on it. `FORGE_MCP_TOKEN` is not needed beside it.

## Setup

From `worker/`:

1. Google Cloud Console: an OAuth client of type Web application, redirect URI `https://<worker host>/callback`. Consent screen in Testing is enough; add each allowed account as a test user.
2. `npm install`, `npx wrangler login`, and copy `wrangler.example.jsonc` to `wrangler.jsonc`. The copy holds your host name and resource ids and is not committed. Then `npx wrangler kv namespace create forge-seat-oauth` and paste the id into it.
3. Set `MCP_RESOURCE_URL` in `wrangler.jsonc` to the deployed endpoint, `https://forge-seat.<account>.workers.dev/mcp`.
4. Give the Worker a route to the server. Either a [Workers VPC](https://developers.cloudflare.com/workers-vpc/) service (beta): `npx wrangler tunnel create forge-seat`, `npx wrangler tunnel run forge-seat` on the server's machine, `npx wrangler vpc service create forge-seat --type http --tunnel-id <id> --ipv4 127.0.0.1 --http-port 3080`, and uncomment `vpc_services` in `wrangler.jsonc`. Or a named Cloudflare Tunnel with a public host name: set `ORIGIN_URL` to `https://<tunnel host>` and add that host to `FORGE_MCP_ALLOWED_HOSTS`.
5. Secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` (comma-separated, lowercase) and `ORIGIN_TOKEN` (the server's `FORGE_MCP_PROXY_TOKEN`, 32+ random characters). Optional `CONSENT_SECRET` (32+ random characters) remembers an approved client for 30 days.
6. `npm run deploy`, and start the server with `FORGE_MCP_PROXY_TOKEN` set.

`npm run dev` serves the Worker on `http://localhost:8788` from a `.dev.vars` file; copy `.dev.vars.example`.

## Who gets in

Sign-in is fail-closed: an empty `ALLOWED_EMAILS` rejects everyone. The allow-list is checked again on every request to `/mcp`, so taking an account off it stops that account's existing tokens. Dynamic client registration is open, as MCP clients expect: anyone can register a client and reach the consent page, and nobody gets a token without an allowed Google account.

## What has been run

Deployed once, on 2026-11-12, with a Workers VPC service on `127.0.0.1`. Checked: the Worker's forwarding against the server in `test/worker-forward.test.ts`, and on the deployed Worker a client that registered itself, signed in with Google and called `initialize`, `tools/list` and `events/list` through the VPC route. ChatGPT connected with OAuth and subscribed to both events, each stored under the principal `google:<sub>` after the callback verification. ChatGPT played one game through the Worker on 2026-11-12. All 40 webhook deliveries got 200 and it renewed its subscriptions before they expired. The seat played unprompted for five minutes and then needed typed nudges. The cause is not established.
