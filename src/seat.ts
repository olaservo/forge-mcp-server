import { Bridge } from "./bridge.js";
import { EventLog } from "./event-log.js";
import { sharedHost } from "./host.js";
import { ChatTracker, MoveTracker, type SeatStatus, YOUR_MOVE } from "./seat-events.js";
import { logEmitted, type ActivityLog } from "./log.js";
import { memoryFor, type SeatMemory } from "./view.js";
import { StatusWatcher } from "./watcher.js";

/**
 * What `forge.your_move` carries besides its summary. For an ask in a game, what forge_game_act would return for
 * it, with the board once the game has begun. For the end of a game with sideboarding open, the sideboard.
 */
export async function eventView(bridge: Bridge, memory: SeatMemory, status: SeatStatus, data: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (data.kind === "game_over") {
    if (data.sideboarding !== true) return undefined;
    const { sideboard, cardText } = await memory.view(bridge, await bridge.get<Record<string, unknown>>("/game"), { commit: false });
    // Without it the next game has begun since this status.
    return sideboard === undefined ? undefined : { sideboard, ...(cardText !== undefined && { cardText }) };
  }
  if (data.kind !== "priority" && data.kind !== "decision") return undefined;
  const game = await bridge.get<Record<string, unknown>>("/game");
  // The prompt has changed since this status. The next status reports the new one.
  if (game.promptCount !== status.game?.promptCount) return undefined;
  return memory.view(bridge, game, { commit: false, board: Number(game.turn ?? 0) > 0 });
}

/**
 * What a server process holds once, whatever its transport: the bridge, the event log, and the watcher
 * that turns bridge revisions into `forge.your_move` and `forge.chat`.
 */
export function createSeat(log?: ActivityLog) {
  const bridge = new Bridge();
  const events = new EventLog();
  logEmitted(events, log);
  const moves = new MoveTracker(events);
  const chat = new ChatTracker(events);
  const memory = memoryFor(bridge);
  const observe = async (status: SeatStatus) => {
    await moves.observeWith(status, (data) => eventView(bridge, memory, status, data));
    chat.observe(status);
  };
  // A client that starts following mid-ask, by a poll or stream without a cursor or a new webhook
  // subscription, is sent the event that reported the pending ask, with its eventId
  events.onPending(YOUR_MOVE, () => moves.current());
  let watcher: StatusWatcher | undefined;

  return {
    bridge,
    events,
    /** Starts watching the bridge. `onStatusChange` runs on each new revision, before the events for it are emitted. */
    start(onStatusChange: () => void): void {
      watcher = new StatusWatcher(
        bridge,
        (_revision, status) => {
          onStatusChange();
          return observe(status);
        },
        // The seat can already be seated and waiting when the bridge first answers
        { onSeed: observe },
      );
      watcher.start();
      // An auto-join seat has to exist before the agent's first tool call
      if (process.env.FORGE_AUTO_JOIN) void bridge.ensureStarted().catch((e: Error) => console.error(e.message));
    },
    stop(): void {
      watcher?.stop();
      bridge.stop();
      sharedHost().stop();
    },
  };
}
