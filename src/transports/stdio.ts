import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { STATUS_URI, createServer, skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";
import { StatusWatcher } from "../watcher.js";

const bridge = new Bridge();
const skills = await skillCatalog();

let server: McpServer | undefined;
void serveStdio(() => (server = createServer({ bridge, skills })));
// stdio has one server; its outbound resources/updated is routed to listen subscribers by the SDK
const watcher = new StatusWatcher(bridge, () => server?.server.sendResourceUpdated({ uri: STATUS_URI }));
watcher.start();
console.error(`forge-mcp-server on stdio; bridge at ${bridge.url}`);

process.on("SIGINT", () => {
  watcher.stop();
  bridge.stop();
  process.exit(0);
});
