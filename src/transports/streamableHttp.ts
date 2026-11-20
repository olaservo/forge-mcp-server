import { skillCatalog } from "../server.js";
import { fileLog } from "../log.js";
import { createSeat } from "../seat.js";
import { listenHttp } from "./http.js";
import { exitOn } from "./shutdown.js";

const seat = createSeat(fileLog());
const { bridge, events } = seat;
const http = listenHttp({ bridge, skills: await skillCatalog(), events, port: Number(process.env.FORGE_MCP_PORT ?? 3080) });
seat.start(() => http.statusChanged());

exitOn(() => {
  http.close();
  seat.stop();
});
