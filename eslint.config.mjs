import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime state and agent workspaces — not part of the app source
    // (mirrors .gitignore; agents write arbitrary code into these).
    ".worktrees/**",
    "data/**",
    "uploads/**",
    "terminals/**",
    "mcps/**",
    "project-builder-ws-folder/**",
    "research/**",
    "daily-summary.js",
  ]),
]);

export default eslintConfig;
