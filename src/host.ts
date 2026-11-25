import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { delimiter } from "node:path";

export interface HostSettings {
  port: number;
  seats: number;
  limited: boolean;
  /** Games per match: 1, 3 or 5. More than 1 needs forge-agent-bridge 0.1.11. */
  games: number;
  /** Seats played by Forge's AI. Needs forge-agent-bridge 0.1.11. */
  ai?: number;
  /** A deck file for each AI seat in slot order. An AI seat with none gets a precon the host picks. */
  aiDecks?: string[];
  /** The lobby name of a seat the host watches for an advising agent. Needs forge-agent-bridge 0.1.11. */
  copilot?: string;
}

/** Where the host serves the watched seat's view, and the token it asks for. */
export interface CopilotAccess {
  seat: string;
  url: string;
  token: string;
}

/** A seat Forge's AI plays, as the host names it when it starts. */
export interface AiSeat {
  slot: number;
  name: string;
  deck: string;
}

export interface HostState extends Partial<Omit<HostSettings, "aiDecks">> {
  running: boolean;
  aiSeats?: AiSeat[];
  /** This machine's IPv4 addresses, for a player on another device to connect to. */
  addresses: string[];
}

export interface LobbyHostOptions {
  /** Path to the Forge desktop jar-with-dependencies. Default: FORGE_JAR. */
  jar?: string;
  /** Path to the forge-agent-bridge jar, 0.1.7 or later. Default: FORGE_BRIDGE_JAR. */
  bridgeJar?: string;
  /** Working directory, the folder that holds `res/`. Default: FORGE_HOME. */
  cwd?: string;
  spawn?: typeof spawn;
  /** A free loopback port for the copilot view. */
  freePort?: () => Promise<number>;
  addresses?: () => string[];
}

const READY = "MATCH_HOST_READY";
const AI_SEAT = /^MATCH_HOST_AI slot=(\d+) name=(.*?) deck=(.*?)\r?$/gm;

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

/**
 * The bridge jar's `MatchHost`: a Forge host with no window and no seat of its own, run as a child process.
 * One per server process.
 */
export class LobbyHost {
  private child?: ChildProcess;
  private settings?: HostSettings;
  private aiSeats?: AiSeat[];
  private starting?: Promise<HostState>;
  private access?: CopilotAccess;

  constructor(private readonly opts: LobbyHostOptions = {}) {}

  state(): HostState {
    const addresses = (this.opts.addresses ?? lanAddresses)();
    if (!this.child || !this.settings) return { running: false, addresses };
    const { aiDecks: _files, ...settings } = this.settings;
    return { running: true, ...settings, ...(this.aiSeats && { aiSeats: this.aiSeats }), addresses };
  }

  /** How to read the watched seat, when the host was started with one. The token is never part of the state. */
  copilot(): CopilotAccess | undefined {
    return this.child ? this.access : undefined;
  }

  /** Starts the host and resolves once it listens. With a host already running, answers its state when the settings match. */
  start(settings: HostSettings, timeoutMs = 180_000): Promise<HostState> {
    if (this.settings) {
      const same =
        this.settings.port === settings.port &&
        this.settings.seats === settings.seats &&
        this.settings.limited === settings.limited &&
        this.settings.games === settings.games &&
        (this.settings.ai ?? 0) === (settings.ai ?? 0) &&
        (this.settings.aiDecks ?? []).join("\n") === (settings.aiDecks ?? []).join("\n") &&
        this.settings.copilot === settings.copilot;
      if (!same) {
        return Promise.reject(new Error(`Already hosting on port ${this.settings.port} with other settings. Stop it with forge_host_stop first.`));
      }
      return this.starting ?? Promise.resolve(this.state());
    }
    const ai = settings.ai ?? 0;
    const aiDecks = settings.aiDecks ?? [];
    if (ai >= settings.seats) return Promise.reject(new Error(`forge_host with ${settings.seats} seats takes at most ${settings.seats - 1} AI seats, so that one is left for a player.`));
    if (ai > 0 && settings.limited) return Promise.reject(new Error("forge_host has no AI seats in a Limited lobby."));
    if (aiDecks.length > ai) return Promise.reject(new Error(`forge_host was given ${aiDecks.length} AI decks for ${ai} AI seats.`));
    this.settings = settings;
    this.starting = this.launch(settings, timeoutMs).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(settings: HostSettings, timeoutMs: number): Promise<HostState> {
    const jar = this.opts.jar ?? process.env.FORGE_JAR;
    const bridgeJar = this.opts.bridgeJar ?? process.env.FORGE_BRIDGE_JAR;
    if (!jar || !bridgeJar) {
      this.settings = undefined;
      throw new Error("Set FORGE_JAR, FORGE_BRIDGE_JAR and FORGE_HOME so this server can start a host.");
    }
    let access: CopilotAccess | undefined;
    let copilotPort = 0;
    if (settings.copilot !== undefined) {
      try {
        copilotPort = await (this.opts.freePort ?? freeLoopbackPort)();
      } catch (e) {
        this.settings = undefined;
        throw e;
      }
      access = { seat: settings.copilot, url: `http://127.0.0.1:${copilotPort}/copilot`, token: randomBytes(32).toString("hex") };
    }
    const args = [
      "-Djava.awt.headless=true",
      "-Dfile.encoding=UTF-8",
      "-Dio.netty.tryReflectionSetAccessible=true",
      "-Xmx2048m",
      "-cp",
      [bridgeJar, jar].join(delimiter),
      "forge.agent.MatchHost",
      "--port",
      String(settings.port),
      "--seats",
      String(settings.seats),
      ...(settings.games !== 1 ? ["--games", String(settings.games)] : []),
      ...(settings.ai ? ["--ai", String(settings.ai), ...(settings.aiDecks ?? []).flatMap((file) => ["--ai-deck", file])] : []),
      ...(settings.limited ? ["--limited"] : []),
      ...(access ? ["--copilot", access.seat, "--copilot-port", String(copilotPort)] : []),
      "--exit-with-parent",
    ];
    const cwd = this.opts.cwd ?? process.env.FORGE_HOME ?? process.cwd();
    // The token goes by environment, so it is not in the process list.
    const env = access ? { ...process.env, FORGE_COPILOT_TOKEN: access.token } : process.env;
    const child = (this.opts.spawn ?? spawn)("java", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.access = access;
    return new Promise<HostState>((resolve, reject) => {
      let errors = "";
      let output = "";
      let ready = false;
      const fail = (message: string) => {
        clearTimeout(timer);
        if (this.child === child) this.stop();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("The Forge host did not come up in time."), timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        process.stderr.write(`[forge-host] ${d}`);
        if (ready) return;
        output = (output + String(d)).slice(-2000);
        // Java ends the line with a carriage return and a line feed on Windows, and "." stops at the first.
        const line = new RegExp(`${READY}[^\\n]*\\n`).exec(output)?.[0];
        if (line === undefined) return;
        ready = true;
        // A MatchHost before 0.1.11 ignores --games and does not name the games in this line.
        if (settings.games !== 1 && !line.includes(` games=${settings.games}`)) {
          return fail(`forge_host with games ${settings.games} needs forge-agent-bridge 0.1.11 or later. The host was stopped.`);
        }
        // A MatchHost before 0.1.11 ignores --ai too, and every slot of its lobby is open.
        if (settings.ai && !new RegExp(` ai=${settings.ai}\\b`).test(line)) {
          return fail(`forge_host with ai ${settings.ai} needs forge-agent-bridge 0.1.11 or later. The host was stopped.`);
        }
        // A MatchHost before 0.1.11 ignores --copilot and names no copilot port in this line.
        if (access && !line.includes(` copilotPort=${copilotPort}`)) {
          return fail("forge_host with copilot needs forge-agent-bridge 0.1.11 or later. The host was stopped.");
        }
        if (settings.ai) {
          this.aiSeats = [...output.matchAll(AI_SEAT)].map((m) => ({ slot: Number(m[1]), name: m[2], deck: m[3] }));
        }
        clearTimeout(timer);
        resolve(this.state());
      });
      child.stderr?.on("data", (d: Buffer) => {
        process.stderr.write(`[forge-host] ${d}`);
        errors = (errors + String(d)).slice(-2000);
      });
      child.on("error", (e) => fail(`The Forge host could not be started: ${e.message}`));
      child.on("exit", (code) => {
        if (this.child !== child) return;
        const missing = errors.includes("ClassNotFoundException") ? " The bridge jar has no MatchHost; it needs forge-agent-bridge 0.1.7 or later." : "";
        const inUse = errors.includes("BindException") ? ` Port ${settings.port} is in use.` : "";
        // The host says why it refuses its arguments, an AI deck it cannot find among them.
        const said = code === 2 ? (/\[match-host\] (.*?)\s*$/.exec(errors)?.[1] ?? "") : "";
        fail(`The Forge host exited with code ${code}.${missing}${inUse}${said && ` ${said}`}`);
      });
    });
  }

  stop(): HostState {
    const child = this.child;
    this.child = undefined;
    this.settings = undefined;
    this.aiSeats = undefined;
    this.access = undefined;
    child?.kill();
    return this.state();
  }
}

let shared: LobbyHost | undefined;

/** One host per process, whatever the number of server instances. */
export function sharedHost(): LobbyHost {
  return (shared ??= new LobbyHost());
}
