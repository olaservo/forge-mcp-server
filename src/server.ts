import { fileURLToPath } from "node:url";
import { McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { Bridge } from "./bridge.js";
import type { DeckLibrary } from "./decks/library.js";
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
  /** Forge's deck folders. Default: the ones FORGE_HOME and the user's Forge folder point to. */
  decks?: DeckLibrary;
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
      "before playing and forge-drafter before drafting. forge_decks lists the decks the seat can bring to a lobby; load forge-deck " +
      "before choosing one or importing a new one. While the seat has nothing to do, wait in one of two ways. " +
      "If your client starts a turn for you when forge.your_move fires (an MCP Events client, or Claude Code with the " +
      "mcp-events mod, which tells you so), end your turn after acting and do not call forge_wait. " +
      "Otherwise call forge_wait instead of polling, or subscribe to forge://status through subscriptions/listen.",
  });

  registerTools(server, bridge, opts.log, opts.decks);
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
