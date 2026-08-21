<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

Shiba Studio is a single **Next.js 16 app** (App Router, React 19, Tailwind 4) that stores all state in an embedded SQLite DB via Node's built-in `node:sqlite`. There is one bundled sub-package: `devvit/reddit-bridge` (a Devvit/Vite Reddit bridge with its own lockfile and `npm run verify`). Standard commands live in `README.md` (Commands table), `package.json` scripts, `docs/development.md`, and CI is `.github/workflows/ci.yml` — use those; they are not duplicated here.

Non-obvious gotchas for this environment:

- **Node must bundle FTS5 (critical).** The DB migrations create FTS5 virtual tables, so `node:sqlite` must have FTS5. The pod's default `/exec-daemon/node` (v22.14) does **not** include FTS5 — running anything against the DB (`npm test`, the dev server, `npm run start`) fails with `no such module: fts5`. A one-time line in `~/.bashrc` puts the **nvm-managed Node** (v22.x, which has FTS5) ahead of `/exec-daemon` on `PATH`, so any normal login shell is already correct (`node -v` → v22.22.x from `~/.nvm`, not `/exec-daemon/node`). If you ever hit `no such module: fts5`, your shell is using the wrong Node — re-source `~/.bashrc` or run `export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)/bin:$PATH"`. Node ABI is identical across 22.14/22.22, so native `node-pty` built during install works under either.
- **Dev server:** `npm run dev` serves on `http://127.0.0.1:3000` (loopback only, by design). Health check: `GET /api/health` → `{"ok":true}`. The dev process also starts the durable Automation engine, a terminal PTY bridge on `ws://127.0.0.1:3911`, and an mDNS responder; the "port 80 needs elevated rights" log line is expected and harmless.
- **No model key needed to smoke-test.** AI features route exclusively through Grok/xAI and need a key/OAuth connected in Settings, but non-AI surfaces (Dashboard, **Board**/Kanban, Settings, and most `/api/*` routes) work without one — e.g. create a Board card via the UI or `POST /api/board {"action":"create","title":"..."}` to exercise SQLite end-to-end.
- **Tests use an isolated data dir.** `npm test` (chained `scripts/verify-*.ts`) points every child at a fresh `SHIBA_DATA_DIR` and never touches `~/.shiba-studio`; a headless Chromium launch check (`verify-theme`) needs the Puppeteer Chromium that `npm install`/`npm ci` downloads.
- **CI parity locally:** `npx eslint lib app/api scripts types` → `npx tsc --noEmit` → `npm run build` → `npm test` → `npm --prefix devvit/reddit-bridge run verify` (see `.github/workflows/ci.yml`).
