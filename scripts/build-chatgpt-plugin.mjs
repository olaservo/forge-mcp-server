#!/usr/bin/env node
// Assembles the ChatGPT plugin as a local marketplace: chatgpt-plugin/plugin.json, the repo's skills,
// and an mcp.json that points at the URL given. Layout from developers.openai.com/plugins/build/plugins.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" } } });

if (!values.url || !URL.canParse(values.url) || new URL(values.url).protocol !== "https:") {
  console.error("usage: node scripts/build-chatgpt-plugin.mjs --url https://<public host>/mcp [--out <folder>]");
  process.exit(1);
}

const out = resolve(values.out ?? join(root, "chatgpt-plugin", "build"));
const plugin = join(out, "plugins", "forge-seat");
const write = (path, json) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(plugin, { recursive: true });
cpSync(join(root, "chatgpt-plugin", "plugin.json"), join(plugin, "plugin.json"));
cpSync(join(root, "skills"), join(plugin, "skills"), { recursive: true });
write(join(plugin, "mcp.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    forge: {
      type: "streamable-http",
      url: values.url,
      // The token itself (FORGE_MCP_TOKEN on the server) is entered when the plugin is connected.
      extensions: { "com.openai": { auth: { type: "api_key", headerScheme: "bearer" } } },
    },
  },
});
write(join(out, ".agents", "plugins", "marketplace.json"), {
  name: "forge-mcp-server",
  interface: { displayName: "Forge MCP Server" },
  plugins: [
    {
      name: "forge-seat",
      source: { source: "local", path: "./plugins/forge-seat" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Entertainment",
    },
  ],
});

console.log(`Plugin marketplace written to ${out}`);
console.log(`Add it with: codex plugin marketplace add "${out}"`);
console.log("Then restart the ChatGPT desktop app and install Forge Seat from the Plugins Directory.");
