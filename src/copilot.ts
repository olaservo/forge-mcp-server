import type { Bridge } from "./bridge.js";
import type { CopilotAccess, LobbyHost } from "./host.js";
import { SeatMemory } from "./view.js";

type Json = Record<string, unknown>;

/** How often a waiting read asks the host again. */
const POLL_MS = 500;

/** The watched seat's view has no game log to fetch, so its memory never calls a bridge. */
const NO_BRIDGE = { get: async () => ({}) } as unknown as Bridge;

/** What the agent has been told of the watched seat's game, kept while the same host runs. */
const memories = new WeakMap<LobbyHost, { token: string; memory: SeatMemory }>();

function memoryFor(host: LobbyHost, access: CopilotAccess): SeatMemory {
  const kept = memories.get(host);
  if (kept?.token === access.token) return kept.memory;
  const memory = new SeatMemory();
  memories.set(host, { token: access.token, memory });
  return memory;
}

const filled = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * The host's `GET /copilot` answer as a game the seat's own bridge would give, so one view shapes both. A
 * copilot is asked at any moment, so the hand and the board are given whether or not the seat holds priority.
 */
function asGame(body: Json): Json {
  const game: Json = { ...body, waiting: false, priorityPrompt: true };
  const selection = body.selection as Json | null | undefined;
  delete game.selection;
  if (selection) {
    const { actionable, ...rest } = selection;
    if (filled(actionable)) game.actionable = actionable;
    if (filled(rest.cards) || filled(rest.players) || filled(rest.stack) || filled(rest.chosen)) {
      if (!filled(rest.stack)) delete rest.stack;
      game.selection = rest;
    }
  }
  return game;
}

async function read(access: CopilotAccess, fetchImpl: typeof fetch): Promise<Json> {
  let res: Response;
  try {
    res = await fetchImpl(access.url, { headers: { authorization: `Bearer ${access.token}` } });
  } catch {
    throw new Error("The host's copilot port did not answer. The host may have stopped.");
  }
  if (!res.ok) throw new Error(`The host's copilot port answered ${res.status}.`);
  return (await res.json()) as Json;
}

export interface CopilotViewOptions {
  /** A `revision` already read: wait until the seat's view differs from it. */
  since?: number;
  /** The longest wait, in seconds. */
  timeout?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the watched seat is shown, in the shape of a seat's own view. This reads and never writes: the host's
 * copilot port has no route that acts, and nothing here reaches the seat's controls.
 */
export async function copilotView(host: LobbyHost, opts: CopilotViewOptions = {}): Promise<Json> {
  const access = host.copilot();
  if (!access) {
    return { watching: false, message: "This server's host has no copilot. Start one with forge_host and `copilot` set to the lobby name of the seat to watch." };
  }
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (opts.timeout ?? 0) * 1000;
  let body = await read(access, fetchImpl);
  while (opts.since !== undefined && body.revision === opts.since && Date.now() < deadline) {
    await sleep(POLL_MS);
    body = await read(access, fetchImpl);
  }
  if (body.watching !== true) {
    return { seat: access.seat, watching: false, message: `${access.seat} is in no game now. The view starts when a game with that seat starts.` };
  }
  const view = await memoryFor(host, access).view(NO_BRIDGE, asGame(body), { commit: true, board: true });
  const out: Json = { seat: access.seat, watching: true, revision: body.revision, ...view };
  if (opts.since !== undefined && body.revision === opts.since) out.unchanged = true;
  if (body.waiting === true) out.waiting = true;
  for (const key of ["dialog", "lastAnswer", "lastReveal"]) if (body[key] !== null && body[key] !== undefined) out[key] = body[key];
  return out;
}
