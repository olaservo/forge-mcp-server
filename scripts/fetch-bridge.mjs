#!/usr/bin/env node
// Puts the forge-agent-bridge release named in package.json's `forgeAgentBridge` into bridge/, for the
// npm package: the jar, checked against the recorded sha256, and the bridge's GPL-3.0 license.
// Runs before `npm pack` and `npm publish`. A jar already there with the right hash is kept.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version, forge, sha256 } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).forgeAgentBridge;
const name = `forge-agent-bridge-${version}-forge-${forge}.jar`;
const repo = "https://github.com/olaservo/forge-agent-bridge";
const dir = join(root, "bridge");
const jar = join(dir, name);

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

mkdirSync(dir, { recursive: true });
if (existsSync(jar) && hash(readFileSync(jar)) === sha256) {
  console.log(`bridge/${name} is already there`);
} else {
  const bytes = await get(`${repo}/releases/download/v${version}/${name}`);
  const got = hash(bytes);
  if (got !== sha256) throw new Error(`${name} has sha256 ${got}, package.json records ${sha256}`);
  writeFileSync(jar, bytes);
  console.log(`fetched bridge/${name}`);
}
writeFileSync(join(dir, "LICENSE"), await get(`https://raw.githubusercontent.com/olaservo/forge-agent-bridge/v${version}/LICENSE`));
writeFileSync(
  join(dir, "README.md"),
  `# forge-agent-bridge ${version}\n\n` +
    `\`${name}\` is the [forge-agent-bridge](${repo}) release ${version}, built for Forge ${forge}, unchanged. ` +
    `It is licensed under the GPL-3.0 (\`LICENSE\` here) and its source is at ${repo}/tree/v${version}. ` +
    `forge-mcp-server starts it when \`FORGE_BRIDGE_JAR\` is not set.\n`,
);
