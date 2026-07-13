import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // This app is not compiled with React Compiler yet. Keep the newer
    // compiler-readiness checks visible without making existing imperative UI
    // state patterns or third-party data shapes fail the production lint gate.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
    },
  },
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
    "pocs/**",
    ".tmp-*",
    "scripts/_shib*",
    "project-builder-ws-folder/**",
    "research/**",
    "daily-summary.js",
  ]),
]);

export default eslintConfig;
