import { fileURLToPath } from "node:url";
import { McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { Bridge } from "./bridge.js";
import { EventLog, registerEvents } from "./events.js";
import type { WebhookHub } from "./webhooks.js";
import { registerTools } from "./tools/index.js";

export const SERVER_INFO = { name: "forge-mcp-server", version: "0.1.0" } as const;

/** Resource that changes on every bridge revision; transports push `notifications/resources/updated` for it. */
export const STATUS_URI = "forge://status";

let skillsPromise: Promise<SkillCatalog> | undefined;

/** Loads `skills/` next to `dist/` (or `src/`) once; every server instance shares the catalog. */
export function skillCatalog(): Promise<SkillCatalog> {
  skillsPromise ??= loadSkills(fileURLToPath(new URL("../skills", import.meta.url)), { prefix: "forge" });
  return skillsPromise;
}

export interface CreateServerOptions {
  bridge?: Bridge;
  skills?: SkillCatalog;
  /** Shared across server instances so every request polls the same log. */
  events?: EventLog;
  /** Webhook subscriptions, shared like `events`. Without it the event types offer poll only. */
  webhooks?: WebhookHub;
  /** The authenticated caller of the request this instance serves. */
  principal?: string;
  /** Receives one line per finished tool call and per poll that returns events. */
  log?: (line: string) => void;
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
  const bridge = opts.bridge ?? new Bridge();
  const server = new McpServer(SERVER_INFO, {
    // subscribe: lets subscriptions/listen honour resourceSubscriptions for forge://status
    // extensions: MCP Events (SEP-3415), declared through extension negotiation
    // events: the same, under the key the design sketch used; the ChatGPT client reads this one
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      extensions: { "io.modelcontextprotocol/events": {} },
      events: {},
    } as ServerCapabilities,
    instructions:
      "Forge (Card-Forge) seat for an agent. Tools drive one headless Forge client that joins a host's online lobby, " +
      "drafts and plays. Start with forge_status, then forge_connect. Load the forge-player skill (skill://forge/forge-player/SKILL.md) " +
      "before playing and forge-drafter before drafting. Use forge_wait between turns instead of polling, " +
      "or subscribe to forge://status through subscriptions/listen to be told when the seat changes. " +
      "A client that speaks MCP Events can subscribe to forge.your_move and is woken when the seat has to act.",
  });

  registerTools(server, bridge, opts.log);
  registerEvents(server, opts.events ?? new EventLog(), opts.webhooks && { hub: opts.webhooks, principal: opts.principal }, opts.log);

  server.registerResource(
    "status",
    STATUS_URI,
    {
      title: "Forge seat status",
      description: "Same payload as forge_status. Updated on every bridge revision; subscribe to it to replace forge_wait polling.",
      mimeType: "application/json",
    },
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
