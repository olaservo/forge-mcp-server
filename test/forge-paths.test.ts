import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { bridgeJar, forgeJar, versionMismatch } from "../src/forge-paths.js";
import { createServer, skillCatalog } from "../src/server.js";
import { fakeBridge } from "./helpers.js";

/** A Forge folder as a release unpacks it, with only the files the lookup reads. */
function forgeRelease(version: string): string {
  const home = mkdtempSync(join(tmpdir(), "forge-release-"));
  mkdirSync(join(home, "res"));
  writeFileSync(join(home, `forge-gui-desktop-${version}-jar-with-dependencies.jar`), "");
  writeFileSync(join(home, `forge-gui-mobile-dev-${version}-jar-with-dependencies.jar`), "");
  return home;
}

describe("forgeJar", () => {
  it("finds the desktop jar in FORGE_HOME", () => {
    const home = forgeRelease("2.0.16");
    expect(forgeJar({ FORGE_HOME: home })).toBe(join(home, "forge-gui-desktop-2.0.16-jar-with-dependencies.jar"));
  });

  it("takes FORGE_JAR over FORGE_HOME", () => {
    expect(forgeJar({ FORGE_HOME: forgeRelease("2.0.16"), FORGE_JAR: "/elsewhere/forge.jar" })).toBe("/elsewhere/forge.jar");
  });

  it("is undefined without either, or when FORGE_HOME has no desktop jar", () => {
    expect(forgeJar({})).toBeUndefined();
    expect(forgeJar({ FORGE_HOME: mkdtempSync(join(tmpdir(), "forge-empty-")) })).toBeUndefined();
    expect(forgeJar({ FORGE_HOME: join(tmpdir(), "no-such-forge-folder") })).toBeUndefined();
  });
});

describe("bridgeJar", () => {
  it("takes FORGE_BRIDGE_JAR, else the bundled jar when it is there", () => {
    const bundled = join(mkdtempSync(join(tmpdir(), "bridge-")), "forge-agent-bridge-0.1.11-forge-2.0.16.jar");
    expect(bridgeJar({}, bundled)).toBeUndefined();
    writeFileSync(bundled, "");
    expect(bridgeJar({}, bundled)).toBe(bundled);
    expect(bridgeJar({ FORGE_BRIDGE_JAR: "/mine.jar" }, bundled)).toBe("/mine.jar");
  });
});

describe("versionMismatch", () => {
  const forge = (v: string) => `C:\\Forge\\forge-gui-desktop-${v}-jar-with-dependencies.jar`;

  it("is undefined when the bridge is built for the Forge version", () => {
    expect(versionMismatch(forge("2.0.16"), "/b/forge-agent-bridge-0.1.11-forge-2.0.16.jar")).toBeUndefined();
  });

  it("names both versions and where to get a match", () => {
    const why = versionMismatch(forge("2.0.17"), "/b/forge-agent-bridge-0.1.11-forge-2.0.16.jar");
    expect(why).toContain("version 2.0.17");
    expect(why).toContain("built for Forge 2.0.16");
    expect(why).toContain("releases/tag/forge-2.0.16");
  });

  it("says nothing when a name carries no version", () => {
    expect(versionMismatch("/f/forge.jar", "/b/forge-agent-bridge-0.1.11-forge-2.0.16.jar")).toBeUndefined();
    expect(versionMismatch(forge("2.0.16"), "/b/bridge.jar")).toBeUndefined();
  });
});

describe("FORGE_SKILLS=0", () => {
  it("serves no skills and leaves the skill URI out of the instructions", async () => {
    const skills = await skillCatalog({ FORGE_SKILLS: "0" });
    expect(skills).toBeUndefined();
    const { bridge } = fakeBridge({});
    const handler = createMcpHandler(() => createServer({ bridge, skills }));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    expect(client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/skills"]).toBeUndefined();
    expect(client.getInstructions()).toContain("forge-player skill");
    expect(client.getInstructions()).not.toContain("skill://");
    await client.close();
  });
});
