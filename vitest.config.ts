import { defineConfig } from "vitest/config";

// The tests import the mod's `hooks/crypto.ts`, and the mod's tsconfig extends a file the Claude Code engine writes
// when it loads the mod. Without this esbuild looks for that file on a machine that has not loaded it.
export default defineConfig({ esbuild: { tsconfigRaw: "{}" } });
