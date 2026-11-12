import { appendFileSync } from "node:fs";
import type { EventLog } from "./events.js";

export type ActivityLog = (line: string) => void;

const stamp = (line: string) => `${new Date().toISOString()} [forge-mcp-server] ${line}`;

/** Activity lines on stderr. */
export const stderrLog: ActivityLog = (line) => console.error(stamp(line));

/** Appends activity lines to the file named by `FORGE_MCP_LOG`. Undefined when the variable is not set. */
export function fileLog(path = process.env.FORGE_MCP_LOG): ActivityLog | undefined {
  if (!path) return undefined;
  return (line) => {
    try {
      appendFileSync(path, `${stamp(line)}\n`);
    } catch (err) {
      console.error(`[forge-mcp-server] could not write ${path}: ${(err as Error).message}`);
    }
  };
}

/** Logs each event as it is emitted, with the kind of ask for a `forge.your_move`. */
export function logEmitted(events: EventLog, log: ActivityLog | undefined): void {
  if (!log) return;
  events.onEmit((event) => log(`event ${event.name} ${event.eventId}${typeof event.data.kind === "string" ? ` kind=${event.data.kind}` : ""}`));
}
