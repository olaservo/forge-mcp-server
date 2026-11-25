import { z } from "zod";
import type { DeckLibrary } from "../decks/library.js";
import type { Bridge } from "../bridge.js";
import { copilotView, seatAt, WATCHES_ONLY } from "../copilot.js";
import type { LobbyHost } from "../host.js";
import * as out from "../schemas.js";
import { acting, failure, readOnly, run, type RegisterTool } from "./common.js";

export function registerHostTools(tool: RegisterTool, host: LobbyHost, decks: DeckLibrary, bridge: Bridge): void {
  if (process.env.FORGE_HOSTING === "0") return;

  tool(
    "forge_host",
    {
      title: "Host a Forge lobby",
      description:
        "Start a Forge host with no window on this machine, for a match with no desktop host. The host has no seat of its own: " +
        "every slot is open, and it starts the match once every slot is taken and each seat is ready with a legal deck. " +
        "Take your own seat with forge_connect at 127.0.0.1 and the port, and set its deck and avatar before forge_lobby_ready: the match starts 3 seconds after the last seat is ready. Other players join from a Forge client at one of `addresses` and the port. " +
        "A match is one game, or the best of 3 or 5 with `games`. " +
        "`ai` gives that many of the seats to Forge's AI, which needs no one to join or ready. `aiSeats` in the answer names each AI and its deck. " +
        "With `copilot` the host watches that seat for forge_copilot_view, and tells each player in the lobby so in chat. A session that hosts with `copilot` takes no seat in that game: forge_connect to it and forge_copilot_view with a seat there are refused. " +
        "The port is open to the local network with no password. Loading cards takes about 40 seconds. " +
        "Called while a host runs with the same settings, it answers that host's state.",
      inputSchema: z.object({
        port: z.number().int().min(1024).max(65535).default(36743).describe("Forge's default is 36743, which a Forge client offers when joining"),
        seats: z.number().int().min(2).max(8).default(2).describe("Number of players, your own seat and the AI seats included"),
        limited: z.boolean().default(false).describe("Limited lobby, for 40-card decks"),
        games: z.literal([1, 3, 5]).default(1).describe("Games per match: 1, or the best of 3 or 5, which needs forge-agent-bridge 0.1.11"),
        ai: z.number().int().min(0).max(7).default(0).describe("Seats played by Forge's AI, fewer than `seats`. Not in a Limited lobby. Needs forge-agent-bridge 0.1.11"),
        aiDecks: z.array(z.string()).default([]).describe("A deck id from forge_decks for each AI seat, in order. An AI seat with none plays a precon picked at random"),
        copilot: z.string().min(1).optional().describe("The lobby name of a seat to watch for forge_copilot_view, a human player you advise. Needs forge-agent-bridge 0.1.11"),
      }),
      outputSchema: out.Host,
      annotations: acting,
    },
    async ({ ai, aiDecks, ...settings }) => {
      // In order this cannot happen, since the seat would need the host first. A bridge that sat down by itself could.
      const seat = settings.copilot === undefined ? undefined : await seatAt(bridge, settings.port).catch(() => undefined);
      if (seat !== undefined) {
        return failure(`This server holds the seat "${seat}" at port ${settings.port}. ${WATCHES_ONLY} Leave with forge_disconnect before hosting with a copilot.`);
      }
      return run(async () => host.start(ai > 0 || aiDecks.length > 0 ? { ...settings, ai, aiDecks: aiDecks.map((id) => decks.pathOf(id)) } : settings));
    },
  );

  tool(
    "forge_copilot_view",
    {
      title: "See what the watched seat sees",
      description:
        "What the player in the seat named by forge_host's `copilot` is shown now: the prompt, the buttons, the hand, the stack, the selection, an open dialog, both battlefields, and rules text once per card name. " +
        "It holds what that player may see and nothing of the other player's hidden cards. It is refused while this server holds a seat on that host. " +
        "It only reads: this tool and this server have no way to act for the watched seat. " +
        "With `since` set to a `revision` you have read, it waits up to `timeout` seconds for the view to change and says `unchanged` when it did not.",
      inputSchema: z.object({
        since: z.number().int().optional().describe("A `revision` already read: wait until the view differs from it"),
        timeout: z.number().min(0).max(300).default(60).describe("With `since`, the longest wait in seconds"),
      }),
      outputSchema: out.CopilotView,
      annotations: readOnly,
    },
    async ({ since, timeout }) => run(() => copilotView(host, bridge, { since, timeout })),
  );

  tool(
    "forge_host_stop",
    {
      title: "Stop hosting",
      description: "Stop the host started by forge_host. Every player in its lobby or match is dropped.",
      inputSchema: z.object({}),
      outputSchema: out.Host,
      annotations: { ...acting, destructiveHint: true, idempotentHint: true },
    },
    async () => run(async () => host.stop()),
  );
}
