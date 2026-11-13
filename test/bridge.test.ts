import { describe, expect, it } from "vitest";
import { Bridge, autoJoinArgs } from "../src/bridge.js";

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
