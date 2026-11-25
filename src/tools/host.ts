import { z } from "zod";
import type { LobbyHost } from "../host.js";
import * as out from "../schemas.js";
import { acting, run, type RegisterTool } from "./common.js";

export function registerHostTools(tool: RegisterTool, host: LobbyHost): void {
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
        "The port is open to the local network with no password. Loading cards takes about 40 seconds. " +
        "Called while a host runs with the same settings, it answers that host's state.",
      inputSchema: z.object({
        port: z.number().int().min(1024).max(65535).default(36743).describe("Forge's default is 36743, which a Forge client offers when joining"),
        seats: z.number().int().min(2).max(8).default(2).describe("Number of players, your own seat included"),
        limited: z.boolean().default(false).describe("Limited lobby, for 40-card decks"),
        games: z.literal([1, 3, 5]).default(1).describe("Games per match: 1, or the best of 3 or 5, which needs forge-agent-bridge 0.1.11"),
      }),
      outputSchema: out.Host,
      annotations: acting,
    },
    async (settings) => run(() => host.start(settings)),
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
