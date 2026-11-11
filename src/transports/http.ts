import { createServer as createHttpServer } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { InMemoryServerEventBus, createMcpHandler } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { STATUS_URI, createServer } from "../server.js";
import type { Bridge } from "../bridge.js";
import type { EventLog } from "../events.js";

export interface HttpOptions {
  bridge: Bridge;
  skills: SkillCatalog;
  events: EventLog;
  port: number;
}

/** Serves `/mcp` over Streamable HTTP. Servers are per request, so resource updates go on the handler's event bus. */
export function listenHttp({ bridge, skills, events, port }: HttpOptions) {
  const host = process.env.FORGE_MCP_HOST ?? "127.0.0.1";
  const allowedHosts = (process.env.FORGE_MCP_ALLOWED_HOSTS ?? `${host},localhost,127.0.0.1`).split(",").map((s) => s.trim());
  const bus = new InMemoryServerEventBus((e) => console.error(`[forge-mcp-server] ${e.message}`));
  const handler = createMcpHandler(() => createServer({ bridge, skills, events }), { bus });
  const nodeHandler = toNodeHandler(handler);
  const guard = hostHeaderValidation(allowedHosts);

  const http = createHttpServer((req, res) => {
    if (!guard(req, res)) return;
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("forge-mcp-server: POST /mcp");
      return;
    }
    void nodeHandler(req, res);
  });
  http.listen(port, host, () => console.error(`forge-mcp-server on http://${host}:${port}/mcp; bridge at ${bridge.url}`));

  return {
    statusChanged: () => bus.publish({ kind: "resource_updated", uri: STATUS_URI }),
    close: () => {
      http.close();
      void handler.close();
    },
  };
}
