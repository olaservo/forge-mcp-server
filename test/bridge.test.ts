import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bridge, autoJoinArgs } from "../src/bridge.js";

/** Stands in for `spawn`: records each command line and starts no process. */
function fakeSpawn() {
  const spawned: string[][] = [];
  let killed = 0;
  const spawnImpl = ((_command: string, args: string[]) => {
    spawned.push(args);
    return { exitCode: null, kill: () => killed++ };
  }) as unknown as typeof spawn;
  return { spawned, spawnImpl, killed: () => killed };
}

describe("autoJoinArgs", () => {
  it("is empty unless FORGE_AUTO_JOIN is set", () => {
    expect(autoJoinArgs({ FORGE_AUTO_JOIN_NAME: "Claude", FORGE_AUTO_JOIN_DECK: "My Deck" })).toEqual([]);
  });

  it("passes the host, the seat name and the deck to the bridge", () => {
    expect(autoJoinArgs({ FORGE_AUTO_JOIN: "127.0.0.1:36743", FORGE_AUTO_JOIN_NAME: "Claude", FORGE_AUTO_JOIN_DECK: "My Deck" })).toEqual([
      "--auto-join",
      "127.0.0.1:36743",
      "--auto-join-name",
      "Claude",
      "--auto-join-deck",
      "My Deck",
    ]);
  });
});

describe("ensureStarted", () => {
  it("shares one start between callers that arrive while the bridge is still loading", async () => {
    let probes = 0;
    let answer!: () => void;
    const loading = new Promise<void>((r) => (answer = r));
    const fetchImpl = (async () => {
      probes++;
      await loading;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const bridge = new Bridge({ baseUrl: "http://bridge.test", fetch: fetchImpl });
    const first = bridge.ensureStarted();
    const second = bridge.ensureStarted();
    answer();
    expect(await Promise.all([first, second])).toEqual(["already-running", "already-running"]);
    expect(probes).toBe(1);
  });
});

describe("a bridge of its own", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is spawned on a free port when no URL is configured, and stopped with the server", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", undefined);
    const { spawned, spawnImpl, killed } = fakeSpawn();
    const asked: string[] = [];
    const fetchImpl = (async (input: string) => {
      asked.push(input);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const bridge = new Bridge({ jar: "forge.jar", bridgeJar: "bridge.jar", fetch: fetchImpl, freePort: async () => 40123, spawn: spawnImpl });
    expect(bridge.url).toBeUndefined();
    await expect(bridge.get("/status")).rejects.toThrow("not started");
    expect(asked).toEqual([]);

    expect(await bridge.ensureStarted()).toBe("started");
    expect(bridge.url).toBe("http://127.0.0.1:40123");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.slice(spawned[0]!.indexOf("--port"))).toEqual(["--port", "40123", "--exit-with-parent"]);
    expect(asked).toEqual(["http://127.0.0.1:40123/status"]);
    expect(await bridge.ensureStarted()).toBe("already-running");
    expect(spawned).toHaveLength(1);

    bridge.stop();
    expect(killed()).toBe(1);
  });

  it("fails a start that is waiting when it is stopped", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", undefined);
    const { spawned, spawnImpl, killed } = fakeSpawn();
    // Stops the bridge on its first probe after the spawn, while the card load would still be running.
    const fetchImpl = (async () => {
      if (spawned.length === 1) bridge.stop();
      throw new Error("connection refused");
    }) as typeof fetch;
    const bridge = new Bridge({ jar: "forge.jar", bridgeJar: "bridge.jar", fetch: fetchImpl, freePort: async () => 40123, spawn: spawnImpl });
    await expect(bridge.ensureStarted()).rejects.toThrow("Forge bridge was stopped before it was ready");
    expect(killed()).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("is not spawned without the jars", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", undefined);
    vi.stubEnv("FORGE_JAR", undefined);
    vi.stubEnv("FORGE_BRIDGE_JAR", undefined);
    vi.stubEnv("FORGE_HOME", undefined);
    const { spawned, spawnImpl } = fakeSpawn();
    const bridge = new Bridge({ freePort: async () => 40123, spawn: spawnImpl });
    expect(await bridge.ensureStarted()).toBe("not-configured");
    expect(spawned).toEqual([]);
    expect(bridge.url).toBeUndefined();
  });

  it("is not spawned for a Forge version it is not built for, and says so on the next call", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", undefined);
    const { spawned, spawnImpl } = fakeSpawn();
    const bridge = new Bridge({
      jar: "/forge/forge-gui-desktop-2.0.17-jar-with-dependencies.jar",
      bridgeJar: "/b/forge-agent-bridge-0.1.11-forge-2.0.16.jar",
      freePort: async () => 40123,
      spawn: spawnImpl,
    });
    await expect(bridge.ensureStarted()).rejects.toThrow("built for Forge 2.0.16");
    expect(spawned).toEqual([]);
    await expect(bridge.get("/status")).rejects.toThrow("could not be started: The Forge jar is version 2.0.17");
  });
});

describe("FORGE_BRIDGE_URL", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names a bridge that is used when it answers", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", "http://127.0.0.1:36744/");
    const { spawned, spawnImpl } = fakeSpawn();
    const asked: string[] = [];
    const fetchImpl = (async (input: string) => {
      asked.push(input);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const bridge = new Bridge({ jar: "forge.jar", bridgeJar: "bridge.jar", fetch: fetchImpl, freePort: async () => 40123, spawn: spawnImpl });
    expect(bridge.url).toBe("http://127.0.0.1:36744");
    expect(await bridge.ensureStarted()).toBe("already-running");
    expect(asked).toEqual(["http://127.0.0.1:36744/status"]);
    expect(spawned).toEqual([]);
  });

  it("is where the bridge is spawned when nothing answers", async () => {
    vi.stubEnv("FORGE_BRIDGE_URL", "http://127.0.0.1:36744");
    const { spawned, spawnImpl } = fakeSpawn();
    const fetchImpl = (async () => {
      if (spawned.length === 0) throw new Error("connection refused");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const bridge = new Bridge({ jar: "forge.jar", bridgeJar: "bridge.jar", fetch: fetchImpl, freePort: async () => 40123, spawn: spawnImpl });
    expect(await bridge.ensureStarted()).toBe("started");
    expect(spawned[0]!.slice(spawned[0]!.indexOf("--port"))).toEqual(["--port", "36744", "--exit-with-parent"]);
    expect(bridge.url).toBe("http://127.0.0.1:36744");
  });
});
