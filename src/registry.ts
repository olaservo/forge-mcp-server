import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a server process says about its HTTP endpoint, for a reader that subscribes to every server on the machine. */
export interface RegistryEntry {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  /** The prefix of the event ids this process emits. */
  source: string;
  pid: number;
  startedAt: string;
  /** The bearer token for `url`, when the process made one up. Absent when it uses `FORGE_MCP_TOKEN`. */
  token?: string;
}

/** The directory of `FORGE_MCP_REGISTRY`, or `~/.forge-seat/servers`. */
export const registryDir = (env: NodeJS.ProcessEnv = process.env): string => env.FORGE_MCP_REGISTRY || join(homedir(), ".forge-seat", "servers");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a live process of another user
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Deletes the entries of processes that no longer run, which a killed server leaves behind. */
export function pruneRegistry(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistryEntry>;
      if (typeof pid === "number" && !alive(pid)) rmSync(path, { force: true });
    } catch {
      // Unreadable now: another process may be writing or removing it
    }
  }
}

/**
 * Writes `<pid>.json` in `dir`, under a temporary name first so a reader never sees half a file.
 * Returns the function that deletes it. The file can hold a token, so it and a directory made here are for the user only.
 */
export function register(dir: string, entry: RegistryEntry): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneRegistry(dir);
  const path = join(dir, `${entry.pid}.json`);
  const temp = join(dir, `${entry.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  renameSync(temp, path);
  return () => rmSync(path, { force: true });
}
