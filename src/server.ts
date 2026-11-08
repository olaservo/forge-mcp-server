import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { Bridge } from "./bridge.js";
import { registerTools } from "./tools/index.js";

export const SERVER_INFO = { name: "forge-mcp-server", version: "0.1.0" } as const;

let skillsPromise: Promise<SkillCatalog> | undefined;

/** Loads `skills/` next to `dist/` (or `src/`) once; every server instance shares the catalog. */
export function skillCatalog(): Promise<SkillCatalog> {
  skillsPromise ??= loadSkills(fileURLToPath(new URL("../skills", import.meta.url)), { prefix: "forge" });
  return skillsPromise;
}

export interface CreateServerOptions {
  bridge?: Bridge;
  skills?: SkillCatalog;
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
  const bridge = opts.bridge ?? new Bridge();
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Forge (Card-Forge) seat for an agent. Tools drive one headless Forge client that joins a host's online lobby, " +
      "drafts and plays. Start with forge_status, then forge_connect. Load the forge-player skill (skill://forge/forge-player/SKILL.md) " +
      "before playing and forge-drafter before drafting. Use forge_wait between turns instead of polling.",
  });

  registerTools(server, bridge);

  server.registerResource(
    "status",
    "forge://status",
    { title: "Forge seat status", description: "Same payload as forge_status", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await bridge.get("/status"), null, 2) }],
    }),
  );
  server.registerResource(
    "game-log",
    "forge://game/log",
    { title: "Game log", description: "All game log lines of the current match", mimeType: "text/plain" },
    async (uri) => {
      const { log } = await bridge.get<{ log: string[] }>("/game/log", { since: 0 });
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: log.join("\n") }] };
    },
  );
  server.registerResource(
    "draft-pool",
    "forge://draft/pool",
    { title: "Drafted pool", description: "The pool delivered at the end of the draft", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await bridge.get("/draft/pool"), null, 2) }],
    }),
  );

  opts.skills?.attach(server);
  return server;
}
