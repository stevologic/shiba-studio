# TODO — Road to Public Release

An honest evaluation of what Shiba Studio needs before it can be released to the world.
Ordered by priority: ship-blockers first, then hardening, then polish and growth.

## 1. Security (ship-blockers)

- [ ] **Bind the server to localhost only.** `next start` listens on all interfaces; anyone on the LAN can reach API routes that execute shell commands (`shell_exec`) with no auth. Bind `127.0.0.1` by default (`next start -H 127.0.0.1`) and/or require a session token for all `/api/*` routes.
- [ ] **CSRF/origin protection.** A malicious website open in the same browser can POST to `http://localhost:3000/api/execute` and drive agents (including shell access). Reject requests whose `Origin`/`Sec-Fetch-Site` is not same-origin.
- [ ] **Change the default tool-approval mode.** `toolApprovalMode` defaults to `yolo`; a public release should default to approval-required for `shell_exec` and `fs_write` outside the workspace, with yolo as an explicit opt-in.
- [ ] **Path-traversal audit.** Review `/api/fs/browse`, `/api/workspace/*`, and Obsidian vault access for `..`/absolute-path escapes beyond intended roots.
- [ ] **Dependency audit.** `npm audit` clean run, pin/refresh dependencies, and add a lockfile-integrity check to CI. Remove unused deps (e.g. verify `framer-motion` is still needed anywhere).
- [ ] **SECURITY.md** with a vulnerability-reporting channel and a short threat model (single-user, local-first, secrets AES-256-GCM at `~/.shiba-studio/shiba-studio.key`).

## 2. Legal & branding (ship-blockers)

- [x] **Add a LICENSE file** — done: MIT ([LICENSE](LICENSE)).
- [x] **Naming review** — done: rebranded to "Shiba Studio"; every remaining GrokDesk reference (env vars, data dirs, key/db filenames, sync snapshots) renamed with automatic migration for existing installs.
- [ ] **Asset licensing.** Confirm the shiba logo, alien avatars, and integration icons are original/licensed for redistribution.
- [ ] **xAI API ToS check** — automated agent traffic, scheduled runs, and multi-agent fan-out must comply with rate/usage terms.

## 3. Reliability & data (before first users)

- [ ] **DB schema versioning.** `lib/db.ts` creates tables but has no migration mechanism; add a `schema_version` pragma/table so future releases can migrate `~/.shiba-studio/data/shiba-studio.db` safely.
- [ ] **Backup/export & import.** One-click export of config + agents + runs + audit log (SQLite file + JSON stores), and restore on a new machine.
- [ ] **Cost guardrails.** Monthly/daily spend limit with a hard stop, warning when a scheduled agent will run N times/day, and per-run token caps surfaced in the UI (usage metering already exists).
- [ ] **Runaway-agent protection.** MAX_STEPS exists per run; add global concurrent-run limits and cron-overlap suppression (skip a tick if the previous run is still going).
- [ ] **Graceful degradation offline** — clear banners when api.x.ai is unreachable; queue or skip scheduled runs instead of erroring silently (audit log now records failures).

## 4. CI, tests & platforms

- [ ] **GitHub Actions matrix**: lint + `next build` + `npm test` on windows/macos/ubuntu × Node 22.5/24. The codebase is cross-platform by design but has only ever been verified on Windows.
- [ ] **Zero out lint debt.** ~76 pre-existing `no-explicit-any` errors (mostly `components/shiba-studio.tsx`, `lib/grok-client.ts`) — type them properly so CI can enforce `--max-warnings 0`.
- [ ] **Browser E2E suite** (Playwright): nav, chat send/stream (stubbed SSE), agent create/run/history, logs pagination + export, capabilities page. Current verify scripts cover runtime/API well but drive almost no real UI.
- [ ] **Test isolation.** `npm test` mutates the live `~/.shiba-studio/data` store (agents get deleted/re-seeded — this session repeatedly hit run⇄agent id mismatches from it). Point the suite at a temp `SHIBA_DATA_DIR`.
- [ ] **Split the god component.** `components/shiba-studio.tsx` (~3,000 lines) should become per-tab modules — required for maintainability once external contributors arrive.

## 5. Distribution & onboarding

- [ ] **Decide the shipping vehicle**: `npx shiba-studio` launcher (fastest), Docker image, and/or Electron/Tauri desktop wrapper (README already positions it as a desktop-app candidate). Tauri keeps the footprint small and gives real localhost binding + native menus.
- [ ] **First-run onboarding wizard** — guided key/OAuth setup, create first agent, run it. Today a new user lands on an empty dashboard and must find Settings on their own.
- [ ] **Make Puppeteer optional.** It downloads a full Chromium (~150 MB) on `npm install` even for users who never use browser automation; switch to lazy install-on-first-use or an env opt-out.
- [ ] **OAuth client registration.** The X OAuth flow needs a registered public client id and verified redirect handling on all platforms for users who won't paste API keys.
- [ ] **Versioning & releases**: semver, CHANGELOG.md, GitHub Releases with a tested upgrade path (see DB migrations above), in-app "update available" notice.

## 6. Documentation & community

- [x] **README refresh for strangers** — done: logo, screenshots, quick start, docs index, highlights.
- [x] **Docs pages** — done: getting-started, chat (incl. workspaces + annotation), agents, automations, capabilities, sync, configuration (`SHIBA_DATA_DIR`/`SHIBA_SECRET_KEY`), development — in `docs/` and rendered on [shiba-studio.io](http://shiba-studio.io).
- [ ] **CONTRIBUTING.md + issue/PR templates + CODE_OF_CONDUCT.md.**
- [ ] **Privacy statement**: everything is local; the only outbound traffic is to xAI and the integrations the user configures.

## 7. Product polish (fast follows)

- [ ] Accessibility pass: full keyboard navigation of modals/tables, ARIA labels on icon buttons (partially done), contrast check on dim text.
- [ ] Search across chats/runs/logs (SQLite FTS5 is available in `node:sqlite`).
- [ ] Notifications for scheduled-run failures (in-app inbox and/or OS notification).
- [ ] Retention settings for runs/audit log (auto-prune with size caps).
- [ ] i18n scaffolding once copy stabilizes.
