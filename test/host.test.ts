import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeHost } from "./helpers.js";

const settings = { port: 36750, seats: 2, limited: true, games: 1 };

describe("LobbyHost", () => {
  it("starts the bridge jar's MatchHost and answers once it listens", async () => {
    const { host, spawned } = fakeHost();
    expect(host.state()).toEqual({ running: false, addresses: ["192.0.2.10"] });
    const state = await host.start(settings);
    expect(state).toEqual({ running: true, ...settings, addresses: ["192.0.2.10"] });
    const args = spawned[0];
    expect(args.slice(args.indexOf("-cp") + 1)).toEqual([`bridge.jar${delimiter}forge.jar`, "forge.agent.MatchHost", "--port", "36750", "--seats", "2", "--limited", "--exit-with-parent"]);
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

  it("passes the games per match and takes the host's word for them", async () => {
    const { host, spawned } = fakeHost("MATCH_HOST_READY port=36750 games=3\n");
    const state = await host.start({ ...settings, games: 3 });
    expect(state).toMatchObject({ running: true, games: 3 });
    const args = spawned[0];
    expect(args.slice(args.indexOf("--seats"))).toEqual(["--seats", "2", "--games", "3", "--limited", "--exit-with-parent"]);
    await expect(host.start(settings)).rejects.toThrow("Already hosting on port 36750");
  });

  it("reads the ready line as Java prints it on Windows", async () => {
    const { host } = fakeHost("MATCH_HOST_AI slot=1 name=Henry deck=Rebel's Call\r\nMATCH_HOST_READY port=36750 games=3 ai=1\r\n");
    const state = await host.start({ ...settings, limited: false, games: 3, ai: 1 }, 500);
    expect(state).toMatchObject({ running: true, games: 3, ai: 1, aiSeats: [{ slot: 1, name: "Henry", deck: "Rebel's Call" }] });
  });

  it("refuses a longer match on a bridge jar that ignores the games", async () => {
    const { host, killed } = fakeHost("MATCH_HOST_READY port=36750\n");
    await expect(host.start({ ...settings, games: 3 })).rejects.toThrow("forge_host with games 3 needs forge-agent-bridge 0.1.11 or later");
    expect(killed).toEqual([1]);
    expect(host.state().running).toBe(false);
  });

  it("passes the AI seats and their decks and answers with the host's names for them", async () => {
    const { host, spawned } = fakeHost("MATCH_HOST_AI slot=1 name=Brian deck=Azorius Advance\nMATCH_HOST_AI slot=2 name=Mylene Wipedolt deck=Basri, Devoted Paladin\r\nMATCH_HOST_READY port=36750 games=1 ai=2\n");
    const open = { ...settings, limited: false, seats: 3 };
    const state = await host.start({ ...open, ai: 2, aiDecks: ["res/quest/precons/Azorius Advance.dck"] });
    expect(state).toEqual({
      running: true,
      ...open,
      ai: 2,
      aiSeats: [
        { slot: 1, name: "Brian", deck: "Azorius Advance" },
        { slot: 2, name: "Mylene Wipedolt", deck: "Basri, Devoted Paladin" },
      ],
      addresses: ["192.0.2.10"],
    });
    const args = spawned[0];
    expect(args.slice(args.indexOf("--seats"))).toEqual(["--seats", "3", "--ai", "2", "--ai-deck", "res/quest/precons/Azorius Advance.dck", "--exit-with-parent"]);
    expect((await host.start({ ...open, ai: 2, aiDecks: ["res/quest/precons/Azorius Advance.dck"] })).running).toBe(true);
    await expect(host.start({ ...open, ai: 1 })).rejects.toThrow("Already hosting on port 36750");
    expect(host.stop()).toEqual({ running: false, addresses: ["192.0.2.10"] });
  });

  it("refuses an AI seat on a bridge jar that ignores it", async () => {
    const { host, killed } = fakeHost("MATCH_HOST_READY port=36750 games=1\n");
    await expect(host.start({ ...settings, limited: false, ai: 1 })).rejects.toThrow("forge_host with ai 1 needs forge-agent-bridge 0.1.11 or later");
    expect(killed).toEqual([1]);
    expect(host.state().running).toBe(false);
  });

  it("refuses AI seats it cannot host before it starts anything", async () => {
    const { host, spawned } = fakeHost();
    await expect(host.start({ ...settings, ai: 1 })).rejects.toThrow("no AI seats in a Limited lobby");
    await expect(host.start({ ...settings, limited: false, ai: 2 })).rejects.toThrow("takes at most 1 AI seats");
    await expect(host.start({ ...settings, limited: false, ai: 1, aiDecks: ["a.dck", "b.dck"] })).rejects.toThrow("given 2 AI decks for 1 AI seats");
    expect(spawned).toHaveLength(0);
    expect(host.state().running).toBe(false);
  });

  it("says when the bridge jar is too old to host", async () => {
    const { host } = fakeHost("", "Error: Could not find or load main class forge.agent.MatchHost\nCaused by: java.lang.ClassNotFoundException: forge.agent.MatchHost\n");
    await expect(host.start(settings)).rejects.toThrow("needs forge-agent-bridge 0.1.7 or later");
    expect(host.state().running).toBe(false);
  });
});
