import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import { delimiter } from "node:path";

export interface HostSettings {
  port: number;
  seats: number;
  limited: boolean;
  /** Games per match: 1, 3 or 5. More than 1 needs forge-agent-bridge 0.1.11. */
  games: number;
}

export interface HostState extends Partial<HostSettings> {
  running: boolean;
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
  addresses?: () => string[];
}

const READY = "MATCH_HOST_READY";

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
  private starting?: Promise<HostState>;

  constructor(private readonly opts: LobbyHostOptions = {}) {}

  state(): HostState {
    const addresses = (this.opts.addresses ?? lanAddresses)();
    return this.child && this.settings ? { running: true, ...this.settings, addresses } : { running: false, addresses };
  }

  /** Starts the host and resolves once it listens. With a host already running, answers its state when the settings match. */
  start(settings: HostSettings, timeoutMs = 180_000): Promise<HostState> {
    if (this.settings) {
      const same =
        this.settings.port === settings.port &&
        this.settings.seats === settings.seats &&
        this.settings.limited === settings.limited &&
        this.settings.games === settings.games;
      if (!same) {
        return Promise.reject(new Error(`Already hosting on port ${this.settings.port} with other settings. Stop it with forge_host_stop first.`));
      }
      return this.starting ?? Promise.resolve(this.state());
    }
    this.settings = settings;
    this.starting = this.launch(settings, timeoutMs).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private launch(settings: HostSettings, timeoutMs: number): Promise<HostState> {
    const jar = this.opts.jar ?? process.env.FORGE_JAR;
    const bridgeJar = this.opts.bridgeJar ?? process.env.FORGE_BRIDGE_JAR;
    if (!jar || !bridgeJar) {
      this.settings = undefined;
      return Promise.reject(new Error("Set FORGE_JAR, FORGE_BRIDGE_JAR and FORGE_HOME so this server can start a host."));
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
      ...(settings.limited ? ["--limited"] : []),
      "--exit-with-parent",
    ];
    const cwd = this.opts.cwd ?? process.env.FORGE_HOME ?? process.cwd();
    const child = (this.opts.spawn ?? spawn)("java", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
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
        const line = new RegExp(`${READY}.*\\n`).exec(output)?.[0];
        if (line === undefined) return;
        ready = true;
        // A MatchHost before 0.1.11 ignores --games and does not name the games in this line.
        if (settings.games !== 1 && !line.includes(` games=${settings.games}`)) {
          return fail(`forge_host with games ${settings.games} needs forge-agent-bridge 0.1.11 or later. The host was stopped.`);
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
        fail(`The Forge host exited with code ${code}.${missing}${inUse}`);
      });
    });
  }

  stop(): HostState {
    const child = this.child;
    this.child = undefined;
    this.settings = undefined;
    child?.kill();
    return this.state();
  }
}

let shared: LobbyHost | undefined;

/** One host per process, whatever the number of server instances. */
export function sharedHost(): LobbyHost {
  return (shared ??= new LobbyHost());
}
