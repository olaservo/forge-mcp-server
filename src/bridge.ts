import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { delimiter } from "node:path";
import { SETUP_HINT, bridgeJar as defaultBridgeJar, forgeJar, versionMismatch } from "./forge-paths.js";

/**
 * HTTP client for the Forge agent bridge (forge-agent-bridge), a headless Forge network client
 * with a loopback JSON API. One bridge is one seat.
 */
export interface BridgeOptions {
  /** Base URL of a bridge other processes may use too. Default: FORGE_BRIDGE_URL. With neither, this process spawns a bridge of its own on a free loopback port. */
  baseUrl?: string;
  /** Path to the Forge desktop jar-with-dependencies. Default: FORGE_JAR, or the one in FORGE_HOME. */
  jar?: string;
  /** Path to the forge-agent-bridge jar. Default: FORGE_BRIDGE_JAR, or the one bundled with this package. With both jars found, the bridge is spawned when it is down. */
  bridgeJar?: string;
  /** Working directory for the spawned bridge. It must contain `res/` (normally the `forge-gui` folder). Default: FORGE_HOME. */
  cwd?: string;
  /** JVM args for the spawned bridge. Default: `-Xmx2048m`. */
  javaArgs?: string[];
  fetch?: typeof fetch;
  /** Picks the port for a bridge of its own. Default: a free loopback port. */
  freePort?: () => Promise<number>;
  /** Starts the Java process. Default: `spawn` from node:child_process. */
  spawn?: typeof spawn;
}

/** A loopback port that is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Bridge arguments that make it sit down by itself when a lobby appears: `FORGE_AUTO_JOIN` is the host's
 * `host:port`, `FORGE_AUTO_JOIN_NAME` the seat name, `FORGE_AUTO_JOIN_DECK` a deck name. Empty when off.
 */
export function autoJoinArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.FORGE_AUTO_JOIN) return [];
  const args = ["--auto-join", env.FORGE_AUTO_JOIN];
  if (env.FORGE_AUTO_JOIN_NAME) args.push("--auto-join-name", env.FORGE_AUTO_JOIN_NAME);
  if (env.FORGE_AUTO_JOIN_DECK) args.push("--auto-join-deck", env.FORGE_AUTO_JOIN_DECK);
  return args;
}

export class BridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class Bridge {
  /** Unset until a bridge of its own has been spawned. */
  private baseUrl?: string;
  /** Whether the bridge is this process's alone, on a port chosen when it is spawned. */
  private readonly own: boolean;
  private readonly fetchImpl: typeof fetch;
  private child?: ChildProcess;
  private starting?: Promise<"already-running" | "started" | "not-configured">;
  /** Why the last start failed, until one succeeds. */
  private startError?: string;

  constructor(private readonly opts: BridgeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.FORGE_BRIDGE_URL)?.replace(/\/$/, "");
    this.own = this.baseUrl === undefined;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** The bridge's base URL. Undefined while a bridge of its own has not been spawned. */
  get url(): string | undefined {
    return this.baseUrl;
  }

  /** Where the bridge is, for a log line. */
  get place(): string {
    return this.baseUrl ?? "a port of its own, chosen when it starts";
  }

  private notReachable(why: string): BridgeError {
    if (this.startError) return new BridgeError(`Forge bridge could not be started: ${this.startError}`);
    return new BridgeError(
      `Forge bridge not reachable at ${this.place} (${why}). ` +
        `${SETUP_HINT} Or start it yourself as the forge-agent-bridge README describes and set FORGE_BRIDGE_URL.`,
    );
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    if (!this.baseUrl) throw this.notReachable("not started");
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return this.request<T>(u.toString(), { method: "GET" });
  }

  async post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    if (!this.baseUrl) throw this.notReachable("not started");
    return this.request<T>(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      throw this.notReachable((e as Error).message);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | undefined)?.error ?? text ?? res.statusText;
      throw new BridgeError(msg, res.status);
    }
    return json as T;
  }

  async isUp(): Promise<boolean> {
    try {
      await this.get("/status");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts the Java bridge if both jars are configured and nothing answers yet. Resolves when /status answers.
   * Without a configured URL the bridge gets a free port, so no other process's server finds it.
   */
  ensureStarted(timeoutMs = 180_000): Promise<"already-running" | "started" | "not-configured"> {
    // The bridge answers only after its card load, so a second caller in that time waits for the first start
    this.starting ??= this.start(timeoutMs)
      .then(
        (result) => ((this.startError = undefined), result),
        (e: Error) => {
          this.startError = e.message;
          throw e;
        },
      )
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(timeoutMs: number): Promise<"already-running" | "started" | "not-configured"> {
    if (await this.isUp()) return "already-running";
    const jar = this.opts.jar ?? forgeJar();
    const bridgeJar = this.opts.bridgeJar ?? defaultBridgeJar();
    if (!jar || !bridgeJar) return "not-configured";
    const mismatch = versionMismatch(jar, bridgeJar);
    if (mismatch) throw new BridgeError(mismatch);
    const cwd = this.opts.cwd ?? process.env.FORGE_HOME ?? process.cwd();
    if (this.own) {
      this.stop();
      this.baseUrl = `http://127.0.0.1:${await (this.opts.freePort ?? freePort)()}`;
    }
    const port = new URL(this.baseUrl!).port || "36744";
    const args = [
      "-Djava.awt.headless=true",
      "-Dfile.encoding=UTF-8",
      "-Dio.netty.tryReflectionSetAccessible=true",
      ...(this.opts.javaArgs ?? ["-Xmx2048m"]),
      "-cp",
      [bridgeJar, jar].join(delimiter),
      "forge.agent.AgentMain",
      "--port",
      port,
      "--exit-with-parent",
      ...autoJoinArgs(),
    ];
    const child = (this.opts.spawn ?? spawn)("java", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => process.stderr.write(`[forge-bridge] ${d}`));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[forge-bridge] ${d}`));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new BridgeError(`Forge bridge exited with code ${child.exitCode} before it was ready`);
      }
      const up = await this.isUp();
      // stop() ran during the wait
      if (this.child !== child) throw new BridgeError("Forge bridge was stopped before it was ready");
      if (up) return "started";
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new BridgeError("Forge bridge did not come up in time");
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
