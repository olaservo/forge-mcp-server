import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { STATUS_URI, createServer, skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";
import { ChatTracker, EventLog, MoveTracker } from "../events.js";
import { StatusWatcher } from "../watcher.js";
import { listenHttp } from "./http.js";

const bridge = new Bridge();
const skills = await skillCatalog();
const events = new EventLog();
const moves = new MoveTracker(events);
const chat = new ChatTracker(events);

let server: McpServer | undefined;
void serveStdio(() => (server = createServer({ bridge, skills, events })));
// FORGE_MCP_PORT also serves /mcp over HTTP, for a client that polls events outside the stdio connection
const http = process.env.FORGE_MCP_PORT ? listenHttp({ bridge, skills, events, port: Number(process.env.FORGE_MCP_PORT) }) : undefined;
// stdio has one server; its outbound resources/updated is routed to listen subscribers by the SDK
const watcher = new StatusWatcher(bridge, (_revision, status) => {
  void server?.server.sendResourceUpdated({ uri: STATUS_URI });
  http?.statusChanged();
  moves.observe(status);
  chat.observe(status);
});
watcher.start();
console.error(`forge-mcp-server on stdio; bridge at ${bridge.url}`);

process.on("SIGINT", () => {
  watcher.stop();
  http?.close();
  bridge.stop();
  process.exit(0);
});
