import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";

const bridge = new Bridge();
const skills = await skillCatalog();

void serveStdio(() => createServer({ bridge, skills }));
console.error(`forge-mcp-server on stdio; bridge at ${bridge.url}`);

process.on("SIGINT", () => {
  bridge.stop();
  process.exit(0);
});
