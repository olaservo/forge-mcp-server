import type { CallToolResult, McpServer, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { avatarPage, avatarSheetPath, AVATARS_PER_PAGE } from "../avatars.js";
import { Bridge } from "../bridge.js";
import { parseDck } from "../decks/decklist.js";
import { sharedLibrary, type DeckLibrary } from "../decks/library.js";
import type { SearchIo } from "../decks/search.js";
import type { ActivityLog } from "../log.js";
import { sharedHost, type LobbyHost } from "../host.js";
import type { GetText } from "../names.js";
import * as out from "../schemas.js";
import { waitForAsk, type SeatStatus } from "../seat-events.js";
import { memoryFor } from "../view.js";
import { acting, failure, readOnly, run, type RegisterTool, type ToolConfig } from "./common.js";
import { registerDeckTools } from "./decks.js";
import { registerHostTools } from "./host.js";
import { registerNameTools } from "./names.js";

/**
 * A lobby change. The bridge answers before the host has applied it, so this waits for the
 * host's next update and returns the lobby as it then stands.
 */
async function lobbyChange(bridge: Bridge, path: string, body: unknown): Promise<unknown> {
  const before = (await bridge.get<{ revision?: number }>("/status")).revision ?? -1;
  const answer = await bridge.post(path, body);
  await bridge.get("/wait", { since: before, timeout: 2 });
  return (await bridge.get<{ lobby?: unknown }>("/status")).lobby ?? answer;
}

/** A status without the draft block when the seat has no draft and no pool, as in a constructed lobby. */
export function withoutIdleDraft<T extends object>(status: T): T {
  const draft = (status as { draft?: { packNumber?: number | null; pickPending?: boolean | null; poolReceived?: boolean | null; picks?: unknown[] | null } | null }).draft;
  if (!draft || draft.pickPending || draft.poolReceived || (draft.packNumber ?? 0) > 0 || (draft.picks?.length ?? 0) > 0) return status;
  const { draft: _idle, ...rest } = status as T & { draft?: unknown };
  return rest as T;
}

/** What forge_status and the forge://status resource return. Starts the bridge when it is down. */
export async function seatStatus(bridge: Bridge, events?: () => { source: string; http: boolean; url?: string; registry?: string }): Promise<Record<string, unknown>> {
  const started = await bridge.ensureStarted().catch((e: Error) => `error: ${e.message}`);
  const status = withoutIdleDraft(await bridge.get<Record<string, unknown>>("/status"));
  return { bridge: { url: bridge.url, startup: started }, events: events?.(), ...status };
}

export function registerTools(
  server: McpServer,
  bridge: Bridge,
  log?: ActivityLog,
  decks: DeckLibrary = sharedLibrary(),
  names?: GetText,
  deckSearch?: SearchIo,
  host: LobbyHost = sharedHost(),
  events?: () => { source: string; http: boolean; url?: string; registry?: string },
): void {
  /** Registers a tool and logs each call. */
  const tool: RegisterTool = <In extends z.ZodType>(name: string, config: ToolConfig<In>, handler: (args: z.output<In>) => Promise<CallToolResult>) => {
    const timed = async (args: z.output<In>) => {
      const started = Date.now();
      try {
        return await handler(args);
      } finally {
        log?.(`tool ${name} started ${new Date(started).toISOString()} took ${Date.now() - started} ms`);
      }
    };
    server.registerTool(name, config, timed as ToolCallback<In>);
  };

  tool(
    "forge_status",
    {
      title: "Forge status",
      description:
        "Everything about this seat in one call: bridge connection to the Forge host, lobby slots and event, " +
        "draft progress (whether a pick is pending), game summary (prompt, buttons, pending decision) and recent chat. " +
        "`events` has the prefix of this process's event ids (`source`) and whether it serves them over HTTP (`http`) and at which address (`url`). " +
        "Call this first, and after forge_wait.",
      inputSchema: z.object({}),
      outputSchema: out.StatusWithBridge,
      annotations: readOnly,
    },
    async () => run(() => seatStatus(bridge, events)),
  );

  tool(
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
        return withoutIdleDraft(await bridge.post<Record<string, unknown>>("/connect", { host, port, name }));
      }),
  );

  tool(
    "forge_disconnect",
    {
      title: "Leave the Forge host",
      description: "Drop the connection to the host. The seat is lost; the host may replace it with an AI.",
      inputSchema: z.object({}),
      outputSchema: out.Status,
      annotations: acting,
    },
    async () => run(async () => withoutIdleDraft(await bridge.post<Record<string, unknown>>("/disconnect"))),
  );

  tool(
    "forge_lobby_ready",
    {
      title: "Set lobby ready",
      description:
        "Toggle the Ready flag on our lobby slot. Before a draft or sealed event starts, ready up with no deck. For the match after it, build the deck with forge_draft_deck first.",
      inputSchema: z.object({ ready: z.boolean().default(true) }),
      outputSchema: out.Lobby,
      annotations: acting,
    },
    async ({ ready }) => run(() => lobbyChange(bridge, "/lobby/ready", { ready })),
  );

  tool(
    "forge_lobby_name",
    {
      title: "Set lobby name",
      description:
        "Rename our seat in the lobby. Use it when the seat was taken for you under a placeholder name (auto-join) " +
        "and you want the other players to see your own. Works in the lobby, before the game starts.",
      inputSchema: z.object({ name: z.string().trim().min(1).max(40) }),
      outputSchema: out.Lobby,
      annotations: acting,
    },
    async ({ name }) => run(() => lobbyChange(bridge, "/lobby/name", { name })),
  );

  tool(
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

  tool(
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
    async ({ index }) => run(() => lobbyChange(bridge, "/lobby/avatar", { index })),
  );

  tool(
    "forge_lobby_deck",
    {
      title: "Set lobby deck",
      description:
        "Choose the deck for our lobby slot. After a draft or sealed event, build the deck with forge_draft_deck instead. " +
        "`id` picks any deck listed by forge_decks. `name` picks a deck by its name when one deck has it; " +
        "`dck` submits deck-file text ([metadata]/[Main]/[Sideboard] sections). " +
        "The answer describes the deck once: `cards` has each card of the main deck with its count, cost, type, power and toughness and rules text. " +
        "Read it before you ready, since the game does not send these cards' text again.",
      inputSchema: z.object({
        id: z.string().optional().describe("A deck id from forge_decks"),
        name: z.string().optional(),
        dck: z.string().optional(),
      }),
      outputSchema: out.DeckSet,
      annotations: acting,
    },
    async ({ id, name, dck }) =>
      run(async () => {
        // A deck id passed as `name`, as a seat did on 2026-11-22.
        let deckId = id ?? (name?.includes("/") && !dck ? name : undefined);
        if (!deckId && name && !dck) {
          // A bare name, as a seat gave for a precon on 2026-11-24. The bridge knows only two folders by name.
          const wanted = name.trim().toLowerCase();
          const named = (await decks.list({ query: name, limit: 200, offset: 0 })).decks.filter((d) => d.name.toLowerCase() === wanted);
          if (named.length === 1) deckId = named[0].id;
        }
        const chosen = deckId ? decks.read(deckId) : undefined;
        const answer = await bridge.post<Record<string, unknown>>("/lobby/deck", chosen ? { dck: chosen.dck } : { name, dck });
        const main = chosen?.cards.Main ?? (dck ? (parseDck(dck).sections.Main ?? []).map((e) => ({ count: e.count, name: e.name })) : undefined);
        if (!main) return answer;
        const cards = decks.describe(main);
        memoryFor(bridge).brief(cards.filter((c) => c.text !== undefined).map((c) => c.name));
        return { ...answer, ...(chosen?.description && { description: chosen.description }), cards };
      }),
  );

  registerDeckTools(tool, decks, deckSearch);
  registerNameTools(tool, names);
  registerHostTools(tool, host);

  tool(
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

  tool(
    "forge_draft_pack",
    {
      title: "Current draft pack",
      description:
        "The pack in front of us: pack and pick numbers (both from 1), the pick timer with `secondsLeft` when the host set one, and every card with mana cost, type, colors, P/T and oracle text. " +
        "`pickPending` false means we have already picked and the next pack has not arrived; use forge_wait.",
      inputSchema: z.object({}),
      outputSchema: out.Draft,
      annotations: readOnly,
    },
    async () => run(() => bridge.get("/draft/pack")),
  );

  tool(
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

  tool(
    "forge_draft_pool",
    {
      title: "Drafted pool",
      description: "The card pool delivered when the draft ended or the sealed event started, its event tags, and the .dck path it was saved to.",
      inputSchema: z.object({}),
      outputSchema: out.Pool,
      annotations: readOnly,
    },
    async () => run(() => bridge.get("/draft/pool")),
  );

  tool(
    "forge_draft_deck",
    {
      title: "Build the deck from the pool",
      description:
        "Build the deck for the Limited match from the delivered pool and set it on our lobby slot. `main` names the pool cards to play, one entry per copy. " +
        "`lands` adds basic lands, which are free in Limited. The rest of the pool becomes the sideboard, and the deck keeps the pool's name and event tags. " +
        "`problem` is null when the deck is legal, which needs at least 40 cards in `size`. Call it again to change the deck.",
      inputSchema: z.object({
        main: z.array(z.string().min(1)).describe("Pool card names, repeated for each copy played"),
        lands: z.record(z.string(), z.number().int().min(0)).default({}).describe('Basic lands to add, for example {"Swamp": 9, "Mountain": 8}'),
        landSet: z.string().optional().describe("Set code for the basic lands. Default: the set most of the pool comes from"),
      }),
      outputSchema: out.BuiltDeck,
      annotations: acting,
    },
    async ({ main, lands, landSet }) => run(() => bridge.post("/draft/deck", { main, lands, landSet })),
  );

  tool(
    "forge_game_state",
    {
      title: "Game state",
      description:
        "Full view of the current game: turn, phase, active player, each player's life and zones (our hand, both battlefields, graveyards), " +
        "the stack, combat, the current prompt text, the OK/Cancel buttons, and any pending decision that must be answered with forge_game_decide. " +
        "`selection` lists the cards and `players` the prompt offers, including cards in a zone the state does not show, such as the library during a search, and what is `chosen` so far. " +
        "`actionable`, when the bridge reports it, lists the cards the host marks as able to act now: playable cards with priority, creatures that can attack or block while declaring, mana sources while paying. It is a hint, so a card missing from it may still be usable. " +
        "A battlefield card with `phasedOut: true` is phased out and is treated as though it does not exist until it phases in. " +
        "An Aura, Equipment or Fortification has `attachedTo`, the card or player it is attached to. " +
        "Card fields at their default (untapped, no damage, not attacking, and so on) are left out. Rules text is in `cardText` under the card's name, " +
        "and only for names this game has not sent you yet: the cards of the deck you set and cards from an earlier answer are not repeated. `allText: true` sends every name's text again. " +
        "A card keeps its own `text` when it differs from its name's entry, and `[inactive]` marks text that does not apply now. " +
        "`since` has what is new since your last game tool result: `log` lines of the game log, cards `newInHand`, and `messages`. " +
        "Each player has `mana`, the mana floating in its pool. `full: true` returns the bridge's own answer, every field with the text on each card.",
      inputSchema: z.object({
        full: z.boolean().default(false).describe("Every card field, with the rules text on each card"),
        allText: z.boolean().default(false).describe("Rules text for every card name, also the ones sent before"),
      }),
      outputSchema: out.GameState,
      annotations: readOnly,
    },
    async ({ full, allText }) => run(async () => {
      const game = await bridge.get<Record<string, unknown>>("/game");
      return full ? game : memoryFor(bridge).state(bridge, game, allText);
    }),
  );

  tool(
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

  tool(
    "forge_game_act",
    {
      title: "Game action",
      description:
        "One click in the match UI. `ok` and `cancel` press the two prompt buttons (OK passes priority or confirms; Cancel declines). " +
        "`selectCard` with a card `id` plays, activates, taps or targets that card, as the prompt allows. `pay: \"auto\"` lets Forge pay the cost, " +
        "and `pass: true` then passes priority so the spell resolves: `{action: \"selectCard\", id, pay: \"auto\", pass: true}` casts a spell that needs no target in one call. " +
        "`ok` with your own spell or ability on top of the stack passes until the stack is empty, so your own spells and triggers resolve without a prompt between them. `once: true` passes one time, and you are asked again before the next item resolves. " +
        "`endTurn` passes until the end of the turn, whatever the Cancel button reads: no attack, nothing more in either main phase. With a cast, `endTurn: true` resolves the spell and ends the turn. " +
        "With `ok` on the attack, `endTurn: true` attacks and skips your prompts after blockers are declared and in your second main phase, so leave it out when you hold a combat trick or a spell for after combat. " +
        "None of these skips a response to an opponent: when an opponent adds to the stack or attacks you, the passing ends and you are asked before anything resolves. After `endTurn` that is when you have something you could play. " +
        "The Cancel button can read \"Undo\", which takes back your last spell or land, so do not press `cancel` to end a turn. " +
        "`selectPlayer` targets a player by `id`. `useMana` pays with a floating mana color (color: 1=W 2=U 4=B 8=R 16=G 32=C). " +
        "`alphaStrike` attacks with everything, `undo` takes back the last action, `concede` ends the game. " +
        "Once `gameOver` is true: `quit` leaves the match and returns everyone to the lobby, `continue` plays the next game of the match, `newMatch` restarts it. " +
        "`at` is the `promptCount` you are answering: if the prompt has changed, nothing is sent and the answer has `stale: true`. Pass it when you act on an event. " +
        "Returns what you are asked next, after the host has reacted: `prompt`, the enabled `buttons`, `life`, your `hand` when you have priority, the `stack` from the top down, floating `mana`, `selection` and `actionable` when the prompt offers cards, " +
        "`board` the first time it returns your main phase in a turn, `cardText` for card names not sent before, and `since` with what happened since your last result. `waiting: true` means nothing is asked of you: send no action until you are asked. Send one action at a time.",
      inputSchema: z.object({
        action: z.enum(["ok", "cancel", "selectCard", "selectPlayer", "useMana", "alphaStrike", "endTurn", "undo", "concede", "quit", "continue", "newMatch"]),
        id: z.number().int().optional().describe("Card or player id for selectCard / selectPlayer"),
        color: z.number().int().optional().describe("Mana color bits for useMana"),
        pay: z.enum(["auto"]).optional().describe("Press Auto if the action leads to the prompt that pays a cost"),
        pass: z.boolean().optional().describe("Afterwards, pass priority if your own spell or ability is on top of the stack"),
        once: z.boolean().optional().describe("With ok: pass priority one time only"),
        endTurn: z.boolean().optional().describe("With ok or a cast: also pass until the end of the turn"),
        at: z.number().int().optional().describe("The promptCount this action answers"),
      }),
      outputSchema: out.View,
      annotations: acting,
    },
    async ({ action, id, color, pay, pass, once, endTurn, at }) =>
      run(async () => {
        const memory = memoryFor(bridge);
        memory.saw(at);
        const extras = { ...(pay && { pay }), ...(pass && { pass }), ...(once && { once }), ...(endTurn && { endTurn }), ...(at !== undefined && { at }) };
        const answer = await bridge.post<Record<string, unknown>>("/game/act", { action, id, color, ...extras });
        if (Object.keys(extras).length > 0 && answer.stops === undefined) {
          throw new Error("pay, pass, once, endTurn and at need forge-agent-bridge 0.1.10 or later. The action was sent without them.");
        }
        if (action === "quit") {
          // The host returns the seats to the lobby, and the game summary stays as it was at game over.
          const status = await bridge.get<{ lobby?: unknown; game?: { inGame?: boolean } }>("/status");
          if (!status.game?.inGame) return { left: true, lobby: status.lobby };
        }
        return memory.view(bridge, await bridge.get<Record<string, unknown>>("/game"), { commit: true, stale: answer.stale === true });
      }),
  );

  tool(
    "forge_game_decide",
    {
      title: "Answer a decision",
      description:
        "Answer the `pendingDecision` (a choice dialog: which cards to discard, a mode, yes/no, an ordering, a number or text). " +
        "`choices` are 0-based indices into the decision's options, between its min and max in count; for `order` kinds give all indices in the desired order. " +
        "`text` answers text or number prompts. A number can also come as kind `choices` with the numbers as options and \"Other...\", which leads to a number prompt. " +
        "For kind `assign`, which splits combat damage or a divided amount, give one number per option in `amounts`, adding up to the decision's `amount`. Returns what forge_game_act returns.",
      inputSchema: z.object({
        id: z.number().int().describe("The pendingDecision.id"),
        choices: z.array(z.number().int().min(0)).default([]),
        text: z.string().optional(),
        amounts: z.array(z.number().int().min(0)).optional().describe("For kind assign: the amount for each option, in option order"),
      }),
      outputSchema: out.View,
      annotations: acting,
    },
    async ({ id, choices, text, amounts }) =>
      run(async () => {
        await bridge.post("/game/decide", { id, choices, text, amounts });
        return memoryFor(bridge).view(bridge, await bridge.get<Record<string, unknown>>("/game"), { commit: true });
      }),
  );

  tool(
    "forge_wait",
    {
      title: "Wait for a change",
      description:
        "Block until the seat is asked something (a pick, a prompt, a decision, the lobby before it is ready, the end of a game), another player chats, or `timeout` seconds pass, " +
        "then return the same payload as forge_status. A change that asks nothing of the seat, such as the opponent holding priority, does not return. " +
        "Pass the `revision` from the last status so only newer changes wake it. " +
        "For a client with no event subscription. A seat woken by forge.your_move events ends its turn and does not call this.",
      inputSchema: z.object({
        since: z.number().int().default(-1).describe("Last seen revision; -1 returns immediately"),
        timeout: z.number().int().min(1).max(120).default(30),
      }),
      outputSchema: out.Status,
      annotations: readOnly,
    },
    async ({ since, timeout }) =>
      run(async () => withoutIdleDraft(await waitForAsk((s, t) => bridge.get<SeatStatus>("/wait", { since: s, timeout: t }), since, timeout))),
  );
}
