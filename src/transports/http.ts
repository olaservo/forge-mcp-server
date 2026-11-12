import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, InMemoryServerEventBus, createMcpHandler } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { STATUS_URI, createServer } from "../server.js";
import type { Bridge } from "../bridge.js";
import type { EventLog } from "../events.js";
import { WebhookHub } from "../webhooks.js";

export interface HttpOptions {
  bridge: Bridge;
  skills: SkillCatalog;
  events: EventLog;
  port: number;
  /** Bearer token every request must carry. Defaults to `FORGE_MCP_TOKEN`. Webhook delivery is offered only with one. */
  token?: string;
  /** Bearer token of a proxy that authenticates callers itself and names each one in `x-forge-principal`. Defaults to `FORGE_MCP_PROXY_TOKEN`. */
  proxyToken?: string;
  /** Defaults to a hub configured from `FORGE_MCP_SUBSCRIPTIONS` and `FORGE_MCP_WEBHOOK_INSECURE` when there is a token. */
  webhooks?: WebhookHub;
}

export const PRINCIPAL_HEADER = "x-forge-principal";

const digest = (value: string) => createHash("sha256").update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * Serves `/mcp` over Streamable HTTP. Servers are per request, so resource updates go on the handler's event bus.
 * With a token, a request without `Authorization: Bearer <token>` gets 401, and the caller's principal is
 * `token:` and the first 8 hex digits of the token's SHA-256. A request with the proxy token is from a proxy
 * that has authenticated the caller, and its principal is the `x-forge-principal` header the proxy set.
 */
export function listenHttp({ bridge, skills, events, port, ...opts }: HttpOptions) {
  const host = process.env.FORGE_MCP_HOST ?? "127.0.0.1";
  const allowedHosts = (process.env.FORGE_MCP_ALLOWED_HOSTS ?? `${host},localhost,127.0.0.1`).split(",").map((s) => s.trim());
  const token = opts.token ?? process.env.FORGE_MCP_TOKEN;
  const proxyToken = opts.proxyToken ?? process.env.FORGE_MCP_PROXY_TOKEN;
  const webhooks =
    opts.webhooks ??
    (token || proxyToken ? new WebhookHub(events, { file: process.env.FORGE_MCP_SUBSCRIPTIONS, insecure: process.env.FORGE_MCP_WEBHOOK_INSECURE === "1" }) : undefined);
  const tokenAuth: AuthInfo | undefined = token ? { token, clientId: `token:${digest(token).toString("hex").slice(0, 8)}`, scopes: [] } : undefined;
  const bus = new InMemoryServerEventBus((e) => console.error(`[forge-mcp-server] ${e.message}`));
  const handler = createMcpHandler((ctx) => createServer({ bridge, skills, events, webhooks, principal: ctx.authInfo?.clientId }), { bus });
  const nodeHandler = toNodeHandler(handler);
  const guard = hostHeaderValidation(allowedHosts);

  const http = createHttpServer((req, res) => {
    if (!guard(req, res)) return;
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("forge-mcp-server: POST /mcp");
      return;
    }
    let auth = tokenAuth;
    if (token || proxyToken) {
      const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const principal = req.headers[PRINCIPAL_HEADER];
      if (proxyToken && same(given, proxyToken) && typeof principal === "string" && principal.trim()) {
        auth = { token: given, clientId: principal.trim(), scopes: [] };
      } else if (!token || !same(given, token)) {
        res.writeHead(401, { "www-authenticate": "Bearer" });
        res.end("forge-mcp-server: missing or wrong bearer token");
        return;
      }
    }
    void nodeHandler(Object.assign(req, { auth }), res);
  });
  // A port that is already taken (another session's server) must not take the stdio server down with it.
  http.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`forge-mcp-server: no HTTP endpoint on ${host}:${port} (${err.code ?? err.message}); events over HTTP are unavailable in this process`);
  });
  http.listen(port, host, () => {
    const mode = token || proxyToken ? "bearer token required" : "no authentication";
    console.error(`forge-mcp-server on http://${host}:${(http.address() as AddressInfo).port}/mcp (${mode}); bridge at ${bridge.url}`);
  });

  return {
    statusChanged: () => bus.publish({ kind: "resource_updated", uri: STATUS_URI }),
    /** The port in use, once listening. */
    port: () => (http.address() as AddressInfo).port,
    close: () => {
      http.close();
      void handler.close();
    },
  };
}
