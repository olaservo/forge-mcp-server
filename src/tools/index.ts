import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { avatarPage, avatarSheetPath, AVATARS_PER_PAGE } from "../avatars.js";
import { Bridge, BridgeError } from "../bridge.js";
import * as out from "../schemas.js";

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const failure = (e: unknown): CallToolResult => ({
  content: [{ type: "text", text: e instanceof BridgeError ? e.message : String(e) }],
  isError: true,
});

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (e) {
    return failure(e);
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const acting = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export function registerTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    "forge_status",
    {
      title: "Forge status",
      description:
        "Everything about this seat in one call: bridge connection to the Forge host, lobby slots and event, " +
        "draft progress (whether a pick is pending), game summary (prompt, buttons, pending decision) and recent chat. " +
        "Call this first, and after forge_wait.",
      inputSchema: z.object({}),
      outputSchema: out.StatusWithBridge,
      annotations: readOnly,
    },
    async () =>
      run(async () => {
        const started = await bridge.ensureStarted().catch((e: Error) => `error: ${e.message}`);
        const status = await bridge.get<Record<string, unknown>>("/status");
        return { bridge: { url: bridge.url, startup: started }, ...status };
      }),
  );

  server.registerTool(
    "forge_connect",
    {
      title: "Join a Forge host",
      description:
        "Connect this seat to a Forge host's online lobby (the host clicks Host in Forge's Online Multiplayer screen; " +
        "default port 36743). Takes an open lobby slot under the given display name.",
      inputSchema: z.object({
        host: z.string().default("127.0.0.1").describe("Hostname or IP of the Forge host"),
        port: z.number().int().default(36743),
        name: z.string().default("Agent").describe("Display name shown to the other players"),
      }),
      outputSchema: out.Status,
      annotations: acting,
    },
    async ({ host, port, name }) =>
      run(async () => {
        await bridge.ensureStarted();
        return bridge.post("/connect", { host, port, name });
      }),
  );

  server.registerTool(
    "forge_disconnect",
    {
      title: "Leave the Forge host",
      description: "Drop the connection to the host. The seat is lost; the host may replace it with an AI.",
      inputSchema: z.object({}),
      outputSchema: out.Status,
      annotations: acting,
    },
    async () => run(() => bridge.post("/disconnect")),
  );

  server.registerTool(
    "forge_lobby_ready",
    {
      title: "Set lobby ready",
      description:
        "Toggle the Ready flag on our lobby slot. In a Limited lobby, set a deck first with forge_lobby_deck (the drafted pool is the default).",
      inputSchema: z.object({ ready: z.boolean().default(true) }),
      outputSchema: out.Lobby,
      annotations: acting,
    },
    async ({ ready }) => run(() => bridge.post("/lobby/ready", { ready })),
  );

  server.registerTool(
    "forge_lobby_avatars",
    {
      title: "Show lobby avatars",
      description:
        `A picture of the avatars a seat can use, ${AVATARS_PER_PAGE} per page, each with its index underneath. ` +
        "Look before choosing one with forge_lobby_avatar. Read from Forge's default skin on this machine.",
      inputSchema: z.object({ page: z.number().int().min(0).default(0) }),
      outputSchema: out.Avatars,
      annotations: readOnly,
    },
    async ({ page }) => {
      try {
        const path = avatarSheetPath();
        if (!path) throw new Error("Set FORGE_HOME (the forge-gui folder) or FORGE_AVATARS (the sprite_avatars.png file).");
        const { png, ...info } = await avatarPage(path, page);
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify(info) },
          ],
          structuredContent: info,
        };
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "forge_lobby_avatar",
    {
      title: "Set lobby avatar",
      description:
        "Choose the avatar picture for our lobby slot by its index. forge_lobby_avatars shows the pictures and their indices. " +
        "Without this the seat uses the avatar from the Forge preferences on the bridge's machine, which matches the host's when both run there.",
      inputSchema: z.object({ index: z.number().int().min(0) }),
      outputSchema: out.Lobby,
      annotations: acting,
    },
    async ({ index }) => run(() => bridge.post("/lobby/avatar", { index })),
  );

  server.registerTool(
    "forge_lobby_deck",
    {
      title: "Set lobby deck",
      description:
        "Choose the deck for our lobby slot. With no arguments, uses the pool delivered by the draft. " +
        "`name` picks a deck from Forge's network-events or constructed folders; `dck` submits deck-file text ([metadata]/[Main]/[Sideboard] sections).",
      inputSchema: z.object({
        name: z.string().optional(),
        dck: z.string().optional(),
      }),
      outputSchema: out.DeckResult,
      annotations: acting,
    },
    async ({ name, dck }) => run(() => bridge.post("/lobby/deck", { name, dck })),
  );

  server.registerTool(
    "forge_chat",
    {
      title: "Send lobby chat",
      description: "Say something in the lobby/game chat. Use it to greet, to explain a play when coaching, or to concede politely.",
      inputSchema: z.object({ text: z.string().min(1) }),
      outputSchema: out.OkResult,
      annotations: acting,
    },
    async ({ text }) => run(() => bridge.post("/chat", { text })),
  );

  server.registerTool(
    "forge_draft_pack",
    {
      title: "Current draft pack",
      description:
        "The pack in front of us: pack and pick numbers, the pick timer, and every card with mana cost, type, colors, P/T and oracle text. " +
        "`pickPending` false means we have already picked and the next pack has not arrived; use forge_wait.",
      inputSchema: z.object({}),
      outputSchema: out.Draft,
      annotations: readOnly,
    },
    async () => run(() => bridge.get("/draft/pack")),
  );

  server.registerTool(
    "forge_draft_pick",
    {
      title: "Draft pick",
      description: "Pick a card from the current pack by exact name (or its 0-based index in the pack).",
      inputSchema: z.object({ card: z.string().min(1) }),
      outputSchema: out.PickResult,
      annotations: acting,
    },
    async ({ card }) => run(() => bridge.post("/draft/pick", { card })),
  );

  server.registerTool(
    "forge_draft_pool",
    {
      title: "Drafted pool",
      description: "The card pool delivered when the draft ended, its event tags, and the .dck path it was saved to.",
      inputSchema: z.object({}),
      outputSchema: out.Pool,
      annotations: readOnly,
    },
    async () => run(() => bridge.get("/draft/pool")),
  );

  server.registerTool(
    "forge_game_state",
    {
      title: "Game state",
      description:
        "Full view of the current game: turn, phase, active player, each player's life and zones (our hand, both battlefields, graveyards), " +
        "the stack, combat, the current prompt text, the OK/Cancel buttons, and any pending decision that must be answered with forge_game_decide. " +
        "`selection` lists the cards the prompt offers, including cards in a zone the state does not show, such as the library during a search.",
      inputSchema: z.object({}),
      outputSchema: out.Game,
      annotations: readOnly,
    },
    async () => run(() => bridge.get("/game")),
  );

  server.registerTool(
    "forge_game_log",
    {
      title: "Game log",
      description: "Game log lines starting at index `since` (0 for all).",
      inputSchema: z.object({ since: z.number().int().min(0).default(0) }),
      outputSchema: out.LogResult,
      annotations: readOnly,
    },
    async ({ since }) => run(() => bridge.get("/game/log", { since })),
  );

  server.registerTool(
    "forge_game_act",
    {
      title: "Game action",
      description:
        "One click in the match UI. `ok` and `cancel` press the two prompt buttons (OK passes priority or confirms; Cancel declines). " +
        "`selectCard` with a card `id` from forge_game_state plays, activates, taps or targets that card, as the prompt allows. " +
        "`selectPlayer` targets a player by `id`. `useMana` pays with a floating mana color (color: 1=W 2=U 4=B 8=R 16=G 32=C). " +
        "`alphaStrike` attacks with everything, `undo` takes back the last action, `concede` ends the game. " +
        "Once `gameOver` is true: `quit` leaves the match and returns everyone to the lobby, `continue` plays the next game of the match, `newMatch` restarts it. " +
        "Returns the game summary after the host has reacted (or after 1.5 s if it has not); send one action at a time.",
      inputSchema: z.object({
        action: z.enum(["ok", "cancel", "selectCard", "selectPlayer", "useMana", "alphaStrike", "undo", "concede", "quit", "continue", "newMatch"]),
        id: z.number().int().optional().describe("Card or player id for selectCard / selectPlayer"),
        color: z.number().int().optional().describe("Mana color bits for useMana"),
      }),
      outputSchema: out.Game,
      annotations: acting,
    },
    async ({ action, id, color }) => run(() => bridge.post("/game/act", { action, id, color })),
  );

  server.registerTool(
    "forge_game_decide",
    {
      title: "Answer a decision",
      description:
        "Answer the pending decision shown by forge_game_state (a choice dialog: which cards to discard, a mode, yes/no, an ordering, a number or text). " +
        "`choices` are 0-based indices into the decision's options, between its min and max in count; for `order` kinds give all indices in the desired order. " +
        "`text` answers text or number prompts.",
      inputSchema: z.object({
        id: z.number().int().describe("The pendingDecision.id from forge_game_state"),
        choices: z.array(z.number().int().min(0)).default([]),
        text: z.string().optional(),
      }),
      outputSchema: out.Game,
      annotations: acting,
    },
    async ({ id, choices, text }) => run(() => bridge.post("/game/decide", { id, choices, text })),
  );

  server.registerTool(
    "forge_wait",
    {
      title: "Wait for a change",
      description:
        "Block until something happens on our seat (a pack arrives, the lobby changes, a prompt or decision appears) or `timeout` seconds pass, " +
        "then return the same payload as forge_status. Pass the `revision` from the last status so only newer changes wake it.",
      inputSchema: z.object({
        since: z.number().int().default(-1).describe("Last seen revision; -1 returns immediately"),
        timeout: z.number().int().min(1).max(120).default(30),
      }),
      outputSchema: out.Status,
      annotations: readOnly,
    },
    async ({ since, timeout }) => run(() => bridge.get("/wait", { since, timeout })),
  );
}
