# TODO — Road to Public Release

An honest evaluation of what Shiba Studio needs before it can be released to the world.
Ordered by priority: ship-blockers first, then hardening, then polish and growth.

## 1. Security (ship-blockers)

- [x] **Bind the server to localhost only** — `npm run dev`/`start` pass `-H 127.0.0.1`; `dev:lan`/`start:lan` are the explicit opt-ins.
- [x] **CSRF/origin protection** — `proxy.ts` rejects `/api/*` requests with a non-loopback `Origin` or `Sec-Fetch-Site: cross-site`; OAuth callbacks exempt (state-protected). Verified with an allow/deny matrix.
- [x] **Terminal bridge origin check** — the node-pty WebSocket on `127.0.0.1:3911` rejected nothing (WebSockets bypass CORS — drive-by shell); now closes foreign origins with 1008. Verified with real WS clients.
- [x] **Default tool-approval mode** — fresh installs default to `ask`; YOLO is an explicit opt-in. Saved configs keep their choice.
- [x] **Path-traversal audit** — Obsidian vault listing `..` escape fixed; `/api/fs/*` and `/api/workspace/*` are machine-wide by design (boundary = origin guard + loopback binding, documented in SECURITY.md).
- [x] **Dependency audit** — zero production advisories after pinning Next.js's bundled PostCSS to the patched release; CI runs `npm audit --audit-level=high` with lockfile-exact `npm ci`.
- [x] **SECURITY.md** — threat model, boundaries, non-goals, private reporting channel.

## 2. Legal & branding (ship-blockers)

- [x] **LICENSE** — canonical AGPL-3.0 text in [LICENSE](LICENSE), with the separately negotiated [commercial option](COMMERCIAL.md); package metadata carries `AGPL-3.0-or-later`.
- [x] **Naming review** — rebranded to "Shiba Studio"; legacy GrokDesk data migrates automatically.
- [ ] **Asset licensing.** Confirm the shiba logo, alien avatars, and integration icons are original/licensed for redistribution. *(Needs the author's confirmation of provenance — not automatable.)*
- [ ] **xAI API ToS check** — automated agent traffic, scheduled runs, and multi-agent fan-out must comply with rate/usage terms. *(Needs a human read of current xAI terms.)*

## 3. Reliability & data

- [x] **DB schema versioning** — `PRAGMA user_version` ladder in `lib/db.ts` (v1 baseline, v2 adds FTS5 search tables); migrations run transactionally on open.
- [x] **Backup/export & import** — Settings → Backup & restore: one-file export of config + agents + chats + projects + runs + audit log (+ the encryption key, so a new machine can decrypt); `.pre-restore` safety copies on import. Round-trip verified across isolated data dirs, including cross-machine key adoption.
- [x] **Cost guardrails** — monthly *and* daily budgets with a hard stop (blocks new cloud runs/chats at the limit; local models never blocked; warn-only toggle), per-run token caps enforced in the run loop, and a ⚠ chip on automations firing >24×/day. All in Settings → Cost & safety. Guard behavior covered by functional tests.
- [x] **Runaway-agent protection** — global concurrent-run limit (default 3, atomic slot claim) + schedule-overlap suppression (tick skipped with an audit entry while the previous run of that schedule is live), on top of MAX_STEPS and `schedule_ticks` dedupe.
- [x] **Graceful degradation offline** — cached api.x.ai reachability probe; shell banner with retry when unreachable; scheduled cloud runs skip their tick with an audit entry; interactive runs refuse before spending.

## 4. CI, tests & platforms

- [x] **GitHub Actions matrix** — lint/typecheck/build/`npm test` on windows/macos/ubuntu × Node 22.5/24, plus an audit job (`.github/workflows/ci.yml`).
- [ ] **Zero out lint debt.** `lib/`, `app/api/`, `scripts/`, and `types/` are now **clean**. Remaining ~190 problems live entirely in `components/*.tsx` (≈124 in `shiba-studio.tsx`, 12 `grok-chat-panel`, 11 `chat-sessions-panel`, rest singles) — mostly `no-explicit-any` plus react-compiler `set-state-in-effect`/`no-img-element` warnings needing careful UI refactors. CI lint stays `continue-on-error` until zero; pairs with the component split below.
- [x] **Browser E2E suite (Playwright)** — scaffolded: `playwright.config.ts` (isolated `SHIBA_DATA_DIR`, production server on its own port), `e2e/nav.spec.ts` (every surface renders with zero console errors + sidebar nav), `e2e/settings-and-search.spec.ts` (Cost & safety save round-trip, palette search, logs `?q=` deep link). Run: `npx playwright install chromium` once, `npm run build`, then `npm run test:e2e`. *(Not yet wired into CI — add once flake-checked on all three OSes.)*
- [x] **Test isolation** — `npm test` runs every script against a fresh temp `SHIBA_DATA_DIR`; also fixed this session: `verify-theme` leaked its spawned server on Windows (tree-kill + dynamic free port now), which had been silently breaking later runs via port squatting.
- [ ] **Split the god component.** `components/shiba-studio.tsx` (~5,700 lines post-merge). Concrete plan: the shell (nav/topbar/footer/palette/modals) stays; extract per-tab modules in this order — ① Settings tab (self-contained save handlers; pass `config` + a `reload` callback), ② Dashboard (needs `agents/runs/navStats/config` + run handlers), ③ Agents tab + agent-editor modal (the largest; editor state is already local), ④ Automations. Chat/Projects/Workspace/Logs/Usage/Capabilities panels are already separate components. Do each extraction in its own PR with `npm test` + E2E green between steps; most remaining lint debt falls out with it.

## 5. Distribution & onboarding

- [x] **Shipping vehicles: Docker + npx** — `Dockerfile` (multi-stage, node-pty compiled, Chromium skipped, `SHIBA_DATA_DIR=/data` volume) + `docker-compose.yml` with loopback-only publish; `bin/shiba-studio.mjs` (`npx shiba-studio`: builds once, serves on 127.0.0.1) wired via `package.json` `bin`. *(npm publish itself — removing `"private": true`, choosing the package scope — is the author's call.)*
- [x] **First-run onboarding** — the dashboard shows a live 3-step checklist (connect a model source → create your first agent → run it) that derives from real state and retires itself when all steps are done.
- [x] **Make Puppeteer optional** — documented `PUPPETEER_SKIP_DOWNLOAD=1 npm install` slim path; browser tools fail with the exact one-liner to fetch Chromium on demand. CI/verify-theme keep the download.
- [ ] **OAuth client registration.** The X OAuth flow needs a registered public client id and verified redirect handling on all platforms for users who won't paste API keys.
- [x] **Versioning & releases** — semver (`0.2.0`), [CHANGELOG.md](CHANGELOG.md), tag-triggered release workflow (`.github/workflows/release.yml`, notes extracted from the changelog, tag↔version guard), and an in-app "⬆ vX.Y.Z available" footer notice fed by the GitHub releases API (cached 6 h).

## 6. Documentation & community

- [x] README, docs pages, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, PRIVACY, issue/PR templates — all present and refreshed for the dual-license + hardening changes.
- [x] **Full docs-accuracy pass (post-merge)** — every doc cross-checked against the merged code: added Netlify wherever integrations were listed (agents, architecture, PRIVACY); corrected tool count (30+→40+; actual 48) and API-route count (~30→50+); fixed a factual error in PRIVACY (cloud sync goes to **xAI** file storage, not Google Drive); documented `PUPPETEER_SKIP_DOWNLOAD`, `SHIBA_TEST_DATA_DIR`, `terminal_exec`, the onboarding checklist, overlap/cost guardrails, `npm run test:e2e`, and the new `lib/` modules; verified no stale MIT/YOLO-default claims remain.
- [x] **Interactive API docs** — [docs/api.md](docs/api.md) documents every `/api/*` endpoint with curl examples, plus an **in-app explorer at `/api-docs`** that sends real same-origin test requests (GET safe; POST endpoints warn + require a confirm click). Linked from the footer ("API") and the README docs index.
- [x] **Grok CLI docs** — [docs/cli.md](docs/cli.md): install/detection, routing chat through the CLI, and the `grok_cli` agent tool (effort / self-verify / best-of-N / JSON-schema). CLI support itself was already complete.
- [x] **Report-a-bug link** — footer now has both "Request a feature" and "Report a bug", each routed to its GitHub issue template.

## 7. Product polish

- [x] **Accessibility pass (targeted)** — live-DOM scan across all surfaces: icon-only buttons were already labeled; fixed the last unlabeled controls (default-model select, file inputs) and raised `--text-dim` to clear WCAG AA 4.5:1. *(Full keyboard-trap audit of every modal remains open.)*
- [x] **Search across chats/runs/logs** — SQLite FTS5 (external-content tables + triggers, schema v2) behind `/api/search`; surfaced in the Ctrl+K palette with grouped results that deep-link (`/chat/:id`, `/automations?run=`, `/logs?q=`).
- [ ] **Notifications for scheduled-run failures** (in-app inbox and/or OS notification). Failures and skips are audit-logged today; a surfaced notification is still missing.
- [x] **Retention settings** — optional day-based auto-prune for runs and audit log (Settings → Cost & safety); runs at boot + daily.
- [ ] **i18n scaffolding** once copy stabilizes.

---

## State of the tree (2026-07-12)

The combined release candidate includes integrations, dual licensing, memories and learning, guardrails, backup, search, onboarding, security hardening, and tool-dispatch fixes. Verified: `tsc` clean · `next build` clean · **full `npm test` suite green (15/15 scripts, exit 0)** · **Playwright 17/17 green** · app booted with the feature set live and zero console errors · agent tool-use proven end-to-end · all docs cross-checked against code. Playwright E2E is not yet wired into CI.

### Bugs fixed in the final product-quality pass

- **CRITICAL — agents were sent an empty tool list on every run.** `filterToolsByDisabled` returned the *same* array reference when nothing was disabled (the default); both the agent runtime and the chat/workspace-tools path then reset it in place (`tools.length = 0; push(...enabledTools)`), emptying their own result. The model never learned its tools existed. Filter now always returns a fresh array; guarded by `verify-tool-dispatch.ts`.
- **Local models emitting tool calls as text now work.** Small llama.cpp/Ollama models print the call as JSON in the message content instead of the structured `tool_calls` field; the runtime treated that as the final answer. `lib/inline-tool-calls.ts` recovers it (gated on a real tool name), proven with a functional run (tool executes → clean prose answer).
- **`/capabilities` URL** now resolves to the Integrations/"Capabilities" tab instead of silently falling back to the dashboard.
- Integrations audited end-to-end (Vercel/Netlify/Slack/Discord/Drive/X/Obsidian): tool defs, executor, scope types, per-agent override UI, connection tests, nav counts, and `/api/tools` catalog all present — no stubs.

Still open, in priority order: components lint-zero + god-component split (paired), E2E in CI, failure notifications, OAuth public client, asset/ToS confirmations (human), i18n.
