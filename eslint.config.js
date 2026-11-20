import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "chatgpt-plugin/build/", "worker/.wrangler/", "worker/worker-configuration.d.ts", "claude-code-mod/**/.claude-plugin/types/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // `const { path: _path, ...rest } = x` drops a field on purpose.
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true, varsIgnorePattern: "^_" }] } },
  { files: ["scripts/**"], languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly", URL: "readonly" } } },
);
