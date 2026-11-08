import { createServer as createHttpServer } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer, skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";

const port = Number(process.env.FORGE_MCP_PORT ?? 3080);
const host = process.env.FORGE_MCP_HOST ?? "127.0.0.1";
const allowedHosts = (process.env.FORGE_MCP_ALLOWED_HOSTS ?? `${host},localhost,127.0.0.1`).split(",").map((s) => s.trim());

const bridge = new Bridge();
const skills = await skillCatalog();
const handler = createMcpHandler(() => createServer({ bridge, skills }));
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

http.listen(port, host, () => {
  console.error(`forge-mcp-server on http://${host}:${port}/mcp; bridge at ${bridge.url}`);
});

process.on("SIGINT", () => {
  http.close();
  void handler.close();
  bridge.stop();
  process.exit(0);
});
