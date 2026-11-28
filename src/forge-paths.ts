import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The bridge release this package was tested with, from `forgeAgentBridge` in `package.json`. */
interface BundledBridge {
  version: string;
  forge: string;
  sha256: string;
}

export const BUNDLED_BRIDGE: BundledBridge = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { forgeAgentBridge: BundledBridge }
).forgeAgentBridge;

/** Where `scripts/fetch-bridge.mjs` puts the bundled jar: `bridge/` next to `dist/` (or `src/`). */
export const BUNDLED_BRIDGE_JAR = fileURLToPath(
  new URL(`../bridge/forge-agent-bridge-${BUNDLED_BRIDGE.version}-forge-${BUNDLED_BRIDGE.forge}.jar`, import.meta.url),
);

const DESKTOP_JAR = /^forge-gui-desktop-(.+)-jar-with-dependencies\.jar$/;

/** `FORGE_JAR`, or the desktop jar in `FORGE_HOME`, where a Forge release unpacks it. */
export function forgeJar(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.FORGE_JAR) return env.FORGE_JAR;
  if (!env.FORGE_HOME || !existsSync(env.FORGE_HOME)) return undefined;
  const name = readdirSync(env.FORGE_HOME).find((f) => DESKTOP_JAR.test(f));
  return name && join(env.FORGE_HOME, name);
}

/** `FORGE_BRIDGE_JAR`, or the jar bundled with this package when it is there. */
export function bridgeJar(env: NodeJS.ProcessEnv = process.env, bundled = BUNDLED_BRIDGE_JAR): string | undefined {
  if (env.FORGE_BRIDGE_JAR) return env.FORGE_BRIDGE_JAR;
  return existsSync(bundled) ? bundled : undefined;
}

/**
 * Why the two jars do not go together, or undefined when they do or the names do not say.
 * A bridge jar is built against one Forge version and named `forge-agent-bridge-<version>-forge-<forge version>.jar`.
 */
export function versionMismatch(forge: string, bridge: string): string | undefined {
  const forgeVersion = DESKTOP_JAR.exec(basename(forge))?.[1];
  const bridgeForge = /-forge-(.+)\.jar$/.exec(basename(bridge))?.[1];
  if (!forgeVersion || !bridgeForge || forgeVersion === bridgeForge) return undefined;
  return (
    `The Forge jar is version ${forgeVersion} and the bridge jar is built for Forge ${bridgeForge}. ` +
    `Install Forge ${bridgeForge} (https://github.com/Card-Forge/forge/releases/tag/forge-${bridgeForge}), ` +
    `or set FORGE_BRIDGE_JAR to a bridge built for ${forgeVersion} (https://github.com/olaservo/forge-agent-bridge/releases).`
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** What to set when a jar is missing. */
export const SETUP_HINT =
  "Set FORGE_HOME to the folder you installed Forge in (the one that holds res/ and forge-gui-desktop-<version>-jar-with-dependencies.jar). " +
  "FORGE_JAR and FORGE_BRIDGE_JAR override the jars this server finds there and bundles.";
