import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";

/**
 * HTTP client for the Forge agent bridge (`java -jar forge...jar agent`), which is a headless
 * Forge network client with a loopback JSON API. One bridge equals one seat.
 */
export interface BridgeOptions {
  /** Base URL of a running bridge. Default http://127.0.0.1:36744 */
  baseUrl?: string;
  /** Path to the Forge desktop jar-with-dependencies; when set and the bridge is down, it is spawned. */
  jar?: string;
  /** Path to the forge-agent-bridge jar. When set, `jar` can be an unmodified Forge jar. Default: FORGE_BRIDGE_JAR. */
  bridgeJar?: string;
  /** Working directory for the spawned bridge; must contain `res/` (normally the `forge-gui` folder). */
  cwd?: string;
  /** Extra JVM args for the spawned bridge. */
  javaArgs?: string[];
  fetch?: typeof fetch;
}

/**
 * How to start the bridge. With a separate bridge jar (forge-agent-bridge) it runs beside an unmodified
 * Forge jar on the classpath. Without one, the Forge jar is a build of the fork that has the `agent` mode.
 */
export function launch(forgeJar: string, bridgeJar?: string): string[] {
  if (!bridgeJar) return ["-jar", forgeJar, "agent"];
  return ["-cp", [bridgeJar, forgeJar].join(delimiter), "forge.agent.AgentMain"];
}

export class BridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class Bridge {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private child?: ChildProcess;

  constructor(private readonly opts: BridgeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.FORGE_BRIDGE_URL ?? "http://127.0.0.1:36744").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return this.request<T>(u.toString(), { method: "GET" });
  }

  async post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
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
      throw new BridgeError(
        `Forge bridge not reachable at ${this.baseUrl} (${(e as Error).message}). ` +
          `Start it with: java -Djava.awt.headless=true -jar <forge-gui-desktop jar-with-dependencies> agent --port 36744 ` +
          `from the forge-gui folder, or set FORGE_JAR and FORGE_HOME so this server can start it.`,
      );
    }
    const text = await res.text();
    let json: unknown = undefined;
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

  /** Starts the Java bridge if a jar is configured and nothing answers yet. Resolves when /status answers. */
  async ensureStarted(timeoutMs = 180_000): Promise<"already-running" | "started" | "not-configured"> {
    if (await this.isUp()) return "already-running";
    const jar = this.opts.jar ?? process.env.FORGE_JAR;
    if (!jar) return "not-configured";
    const cwd = this.opts.cwd ?? process.env.FORGE_HOME ?? process.cwd();
    const port = new URL(this.baseUrl).port || "36744";
    const args = [
      "-Djava.awt.headless=true",
      "-Dfile.encoding=UTF-8",
      "-Dio.netty.tryReflectionSetAccessible=true",
      ...(this.opts.javaArgs ?? ["-Xmx2048m"]),
      ...launch(jar, this.opts.bridgeJar ?? process.env.FORGE_BRIDGE_JAR),
      "--port",
      port,
    ];
    this.child = spawn("java", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => process.stderr.write(`[forge-bridge] ${d}`));
    this.child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[forge-bridge] ${d}`));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new BridgeError(`Forge bridge exited with code ${this.child.exitCode} before it was ready`);
      }
      if (await this.isUp()) return "started";
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new BridgeError("Forge bridge did not come up in time");
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
