import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { STATUS_URI, createServer, skillCatalog } from "../server.js";
import { fileLog } from "../log.js";
import { createSeat } from "../seat.js";
import { listenHttp } from "./http.js";
import { exitOn } from "./shutdown.js";

const log = fileLog();
const seat = createSeat(log);
const { bridge, events } = seat;
const skills = await skillCatalog();

let server: McpServer | undefined;
void serveStdio(() => (server = createServer({ bridge, skills, events, log, servesHttp: () => servesHttp })));
// FORGE_MCP_PORT also serves /mcp over HTTP, for a client that polls events outside the stdio connection
const http = process.env.FORGE_MCP_PORT ? listenHttp({ bridge, skills, events, port: Number(process.env.FORGE_MCP_PORT) }) : undefined;
// The port may be another session's, so forge_status says whether this process got it
let servesHttp = false;
void http?.listening.then((listening) => (servesHttp = listening));
// stdio has one server; its outbound resources/updated is routed to listen subscribers by the SDK
seat.start(() => {
  void server?.server.sendResourceUpdated({ uri: STATUS_URI });
  http?.statusChanged();
});
console.error(`forge-mcp-server on stdio; bridge at ${bridge.place}`);

exitOn(() => {
  http?.close();
  seat.stop();
}, { stdin: true });
