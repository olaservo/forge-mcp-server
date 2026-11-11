import { skillCatalog } from "../server.js";
import { Bridge } from "../bridge.js";
import { EventLog, MoveTracker } from "../events.js";
import { StatusWatcher } from "../watcher.js";
import { listenHttp } from "./http.js";

const bridge = new Bridge();
const events = new EventLog();
const moves = new MoveTracker(events);
const http = listenHttp({ bridge, skills: await skillCatalog(), events, port: Number(process.env.FORGE_MCP_PORT ?? 3080) });
const watcher = new StatusWatcher(bridge, (_revision, status) => {
  http.statusChanged();
  moves.observe(status);
});
watcher.start();

process.on("SIGINT", () => {
  watcher.stop();
  http.close();
  bridge.stop();
  process.exit(0);
});
