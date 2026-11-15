import { skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";
import { ChatTracker, EventLog, MoveTracker, YOUR_MOVE } from "../events.js";
import { fileLog, logEmitted } from "../log.js";
import { StatusWatcher } from "../watcher.js";
import { listenHttp } from "./http.js";

const bridge = new Bridge();
const events = new EventLog();
logEmitted(events, fileLog());
const moves = new MoveTracker(events);
const chat = new ChatTracker(events);
// A client that starts following mid-ask is told the ask that is pending
events.onFirstPoll((name) => {
  if (name === YOUR_MOVE) void bridge.get<Record<string, unknown>>("/status").then((status) => moves.replay(status), () => undefined);
});
const http = listenHttp({ bridge, skills: await skillCatalog(), events, port: Number(process.env.FORGE_MCP_PORT ?? 3080) });
const watcher = new StatusWatcher(bridge, (_revision, status) => {
  http.statusChanged();
  moves.observe(status);
  chat.observe(status);
});
watcher.start();
// An auto-join seat has to exist before the agent's first tool call
if (process.env.FORGE_AUTO_JOIN) void bridge.ensureStarted().catch((e: Error) => console.error(e.message));

process.on("SIGINT", () => {
  watcher.stop();
  http.close();
  bridge.stop();
  process.exit(0);
});
