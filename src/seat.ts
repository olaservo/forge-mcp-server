import { Bridge } from "./bridge.js";
import { ChatTracker, EventLog, MoveTracker, YOUR_MOVE } from "./events.js";
import { logEmitted, type ActivityLog } from "./log.js";
import { StatusWatcher } from "./watcher.js";

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
  const observe = (status: Record<string, unknown>) => {
    moves.observe(status);
    chat.observe(status);
  };
  // A client that starts following mid-ask is told the ask that is pending
  events.onFirstPoll((name) => {
    if (name === YOUR_MOVE) void bridge.get<Record<string, unknown>>("/status").then((status) => moves.replay(status), () => undefined);
  });
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
          observe(status);
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
    },
  };
}
