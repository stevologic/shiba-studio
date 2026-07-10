# TODO — Road to Public Release

An honest evaluation of what Shiba Studio needs before it can be released to the world.
Ordered by priority: ship-blockers first, then hardening, then polish and growth.

## 1. Security (ship-blockers)

- [x] **Bind the server to localhost only** — done: `npm run dev`/`start` pass `-H 127.0.0.1`; `dev:lan`/`start:lan` are the explicit opt-ins.
- [x] **CSRF/origin protection** — done: `proxy.ts` (Next 16 middleware) rejects `/api/*` requests with a non-loopback `Origin` or `Sec-Fetch-Site: cross-site` navigation; OAuth callbacks exempt (state-protected). Verified with an allow/deny matrix against the running server.
- [x] **Terminal bridge origin check** — done (found during this audit): the node-pty WebSocket on `127.0.0.1:3911` accepted connections from ANY website (WebSockets bypass CORS — drive-by shell). Now rejects non-loopback origins with close code 1008; verified with real WS clients.
- [x] **Change the default tool-approval mode** — done: fresh installs default to `ask`; YOLO is an explicit opt-in in Settings. Saved configs keep their existing choice.
- [x] **Path-traversal audit** — done: Obsidian vault note read/write already boundary-checked; the vault *listing* dir could escape via `..` — fixed. `/api/fs/browse` and `/api/workspace/*` are machine-wide **by design** (folder picker / workspace editor); their boundary is the origin guard + loopback binding, documented in SECURITY.md.
- [x] **Dependency audit** — `npm audit`: only 2 moderate advisories, both in postcss *bundled inside Next.js* (the only auto-fix is a downgrade to Next 9 — nonsense); tracked in SECURITY.md, re-check on Next upgrades. `framer-motion` confirmed still used (4 modal components). CI runs `npm audit --audit-level=high` + lockfile-exact `npm ci`.
- [x] **SECURITY.md** — done: threat model, boundaries table, non-goals, accepted risks, private reporting channel.

## 2. Legal & branding (ship-blockers)

- [x] **Add a LICENSE file** — done: MIT ([LICENSE](LICENSE)). Duplicate conflicting `LICENSE.md` (older copyright line) removed during this audit.
- [x] **Naming review** — done: rebranded to "Shiba Studio"; legacy GrokDesk data migrates automatically.
- [ ] **Asset licensing.** Confirm the shiba logo, alien avatars, and integration icons are original/licensed for redistribution. *(Not automatable — needs the author's confirmation of provenance.)*
- [ ] **xAI API ToS check** — automated agent traffic, scheduled runs, and multi-agent fan-out must comply with rate/usage terms. *(Needs a human read of current xAI terms.)*

## 3. Reliability & data (before first users)

- [x] **DB schema versioning** — done: `lib/db.ts` stamps `PRAGMA user_version` (v1 = current baseline) with an ordered, transactional `MIGRATIONS` ladder for future releases. Verified against a fresh DB.
- [ ] **Backup/export & import.** One-click export of config + agents + runs + audit log (SQLite file + JSON stores), and restore on a new machine.
- [ ] **Cost guardrails.** Monthly/daily spend limit with a hard stop, warning when a scheduled agent will run N times/day, and per-run token caps surfaced in the UI (usage metering already exists).
- [ ] **Runaway-agent protection.** MAX_STEPS exists per run and duplicate cron ticks are deduped via `schedule_ticks`; still missing: global concurrent-run limit and skip-if-previous-run-still-going.
- [ ] **Graceful degradation offline** — clear banners when api.x.ai is unreachable; queue or skip scheduled runs instead of erroring silently (audit log now records failures).

## 4. CI, tests & platforms

- [x] **GitHub Actions matrix** — done: `.github/workflows/ci.yml` — npm ci (lockfile-exact) + lint + typecheck + build + `npm test` on windows/macos/ubuntu × Node 22.5/24, plus an `npm audit --audit-level=high` job.
- [ ] **Zero out lint debt.** Reduced this audit from 188 errors to 160 (and fixed the eslint config that was sweeping `.worktrees/` — 11,528 phantom problems). Remaining: ~121 in `components/shiba-studio.tsx`, 15 in `grok-chat-panel.tsx`, 13 in `lib/agent-runtime.ts`, 9 in `lib/grok-client.ts` — mostly `no-explicit-any` plus a handful of react-compiler `set-state-in-effect` warnings that need careful refactors in streaming code. The CI lint step is `continue-on-error` until this hits zero.
- [ ] **Browser E2E suite** (Playwright): nav, chat send/stream (stubbed SSE), agent create/run/history, logs pagination + export, capabilities page. Current verify scripts cover runtime/API well but drive almost no real UI.
- [x] **Test isolation** — done: `npm test` gives every child script a fresh `SHIBA_DATA_DIR` under scratch; `SHIBA_TEST_DATA_DIR` overrides. Live `~/.shiba-studio` is never touched. (Also fixed during this audit: two stale structural assertions — OAuth hand-back string, projects-panel redesign — and verify-project-builder failing silently with no stdout.)
- [ ] **Split the god component.** `components/shiba-studio.tsx` (~4,600 lines) should become per-tab modules — required for maintainability once external contributors arrive, and where most of the remaining lint debt lives.

## 5. Distribution & onboarding

- [ ] **Decide the shipping vehicle**: `npx shiba-studio` launcher (fastest), Docker image, and/or Electron/Tauri desktop wrapper. Tauri keeps the footprint small and gives real localhost binding + native menus.
- [ ] **First-run onboarding wizard** — guided key/OAuth setup, create first agent, run it. Today a new user lands on an empty dashboard and must find Settings on their own.
- [ ] **Make Puppeteer optional.** It downloads a full Chromium (~150 MB) on `npm install` even for users who never use browser automation; switch to lazy install-on-first-use or an env opt-out. (Note: `verify-theme` needs it, so CI keeps the download.)
- [ ] **OAuth client registration.** The X OAuth flow needs a registered public client id and verified redirect handling on all platforms for users who won't paste API keys.
- [ ] **Versioning & releases**: semver, CHANGELOG.md, GitHub Releases with a tested upgrade path (DB migrations now exist to support this), in-app "update available" notice.

## 6. Documentation & community

- [x] **README refresh for strangers** — done; updated this audit with the security model, localhost binding, and community links.
- [x] **Docs pages** — done: getting-started, chat, agents, automations, capabilities, sync, configuration, development — refreshed this audit (test isolation, binding, migrations, origin guard).
- [x] **CONTRIBUTING.md + issue/PR templates + CODE_OF_CONDUCT.md** — done (`.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`).
- [x] **Privacy statement** — done: [PRIVACY.md](PRIVACY.md) — everything local, zero telemetry, complete list of what leaves the machine and when.

## 7. Product polish (fast follows)

- [ ] Accessibility pass: full keyboard navigation of modals/tables, ARIA labels on icon buttons (partially done), contrast check on dim text.
- [ ] Search across chats/runs/logs (SQLite FTS5 is available in `node:sqlite`).
- [ ] Notifications for scheduled-run failures (in-app inbox and/or OS notification).
- [ ] Retention settings for runs/audit log (auto-prune with size caps).
- [ ] i18n scaffolding once copy stabilizes.

---

## Fixed during the 2026-07-09 full-codebase audit

Beyond the checkboxes above, this pass also repaired:

- **Typecheck was broken** (5 errors): `defaultTtsVoice`/`defaultTtsSpeed` missing from `AppConfig`; dead Vercel-integration UI (no catalog entry, no backend) removed from Settings.
- **Audit-log spam**: the silent local-models probe (`action: testLocalGrok`) falsely recorded "settings updated · localGrokBaseUrl" on every page load.
- **Dashboard/nav disagreement**: "Active schedules" counted agents on the Dashboard but schedules in the sidebar badge — now both count schedules.
- **ESLint scope**: config now ignores runtime dirs (`.worktrees/`, `data/`, uploads, terminals, mcps) like `.gitignore` does.
- **Repo hygiene**: committed agent-test artifacts (`daily-summary.*`) untracked and gitignored.
- `useRest()` in `lib/obsidian.ts` renamed (`restCreds`) — a server helper the React-hooks linter mistook for a hook (5 false errors).

**Verified end-to-end after the changes**: `tsc` clean · `next build` clean · full `npm test` suite green (isolated) · app booted and every page walked with zero console errors · real chat round-trip against a local model (send → stream → auto-title → delete) · origin-guard allow/deny matrix and WS origin gating exercised against the live server.
