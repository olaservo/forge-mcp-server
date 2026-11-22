import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeHost } from "./helpers.js";

const settings = { port: 36750, seats: 2, limited: true };

describe("LobbyHost", () => {
  it("starts the bridge jar's MatchHost and answers once it listens", async () => {
    const { host, spawned } = fakeHost();
    expect(host.state()).toEqual({ running: false, addresses: ["192.0.2.10"] });
    const state = await host.start(settings);
    expect(state).toEqual({ running: true, ...settings, addresses: ["192.0.2.10"] });
    const args = spawned[0];
    expect(args.slice(args.indexOf("-cp") + 1)).toEqual([`bridge.jar${delimiter}forge.jar`, "forge.agent.MatchHost", "--port", "36750", "--seats", "2", "--limited"]);
  });

  it("answers the running host for the same settings and refuses others", async () => {
    const { host, spawned } = fakeHost();
    await host.start(settings);
    expect((await host.start(settings)).running).toBe(true);
    expect(spawned).toHaveLength(1);
    await expect(host.start({ ...settings, port: 36751 })).rejects.toThrow("Already hosting on port 36750");
  });

  it("stops the process and can host again", async () => {
    const { host, spawned, killed } = fakeHost();
    await host.start(settings);
    expect(host.stop()).toEqual({ running: false, addresses: ["192.0.2.10"] });
    expect(killed).toEqual([1]);
    await host.start({ ...settings, limited: false });
    expect(spawned[1]).not.toContain("--limited");
  });

  it("says when the bridge jar is too old to host", async () => {
    const { host } = fakeHost("", "Error: Could not find or load main class forge.agent.MatchHost\nCaused by: java.lang.ClassNotFoundException: forge.agent.MatchHost\n");
    await expect(host.start(settings)).rejects.toThrow("needs forge-agent-bridge 0.1.7 or later");
    expect(host.state().running).toBe(false);
  });
});
