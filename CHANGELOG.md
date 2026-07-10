# Changelog

All notable changes to Shiba Studio. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[semver](https://semver.org/). Upgrades are safe in place: the SQLite store
migrates itself (`PRAGMA user_version` ladder) and legacy data directories
are carried over automatically.

## [0.2.0] — 2026-07-10

### Added
- **Backup & restore** — Settings → Backup & restore exports the whole studio
  (settings, agents, chats, projects, runs, audit log, encryption key) as one
  file and restores it on a new machine (`/api/backup`).
- **Cost guardrails** — monthly *and* daily spend limits with an optional hard
  stop that blocks new cloud runs/chats at the limit; per-run token caps; a
  ⚠ warning on automations that fire more than 24×/day.
- **Runaway-agent protection** — global concurrent-run limit (default 3) and
  schedule-overlap suppression (a tick is skipped, with an audit entry, while
  the previous run of the same schedule is still going).
- **Offline degradation** — a banner when api.x.ai is unreachable; scheduled
  cloud runs skip their tick with an audit entry instead of erroring.
- **Global search** — Ctrl+K now searches chats, agent runs, and the audit log
  (SQLite FTS5) alongside commands.
- **Retention settings** — optional auto-prune windows for runs and the audit
  log (Settings → Cost & safety).
- **Shipping vehicles** — `Dockerfile` + `docker-compose.yml` (loopback-only
  publish) and a `shiba-studio` bin for `npx`-style launching.
- **Update notice** — the footer shows when a newer GitHub release exists.
- **Security hardening** — server binds `127.0.0.1` by default
  (`dev:lan`/`start:lan` opt out), same-origin guard on every API route,
  terminal-bridge WebSocket origin checks, tool approval defaults to Ask,
  Obsidian vault path-escape fix. See SECURITY.md.
- **CI** — GitHub Actions matrix (Windows/macOS/Linux × Node 22.5/24):
  lockfile-exact install, lint, typecheck, build, functional suite, audit.
- Community docs: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, PRIVACY,
  issue/PR templates.

### Changed
- `npm test` is fully isolated — it writes to a temp data dir, never
  `~/.shiba-studio`.
- SQLite schema is versioned (`user_version` = 2: adds FTS5 search tables).
- Slim installs: `PUPPETEER_SKIP_DOWNLOAD=1 npm install` skips the ~150 MB
  Chromium; browser tools explain how to fetch it on first use.

### Fixed
- Audit log no longer records a false "settings updated" for the silent
  local-model connectivity probe on every page load.
- Dashboard "Active schedules" now counts schedules (matched the sidebar).
- Licensing consolidated: dual AGPL-3.0-or-later / commercial (see `LICENSE`).
- Dead Vercel-integration UI removed from Settings; TTS settings typed.

## [0.1.0] — 2026-07-08

Initial public-facing tree: Grok Chat with workspaces and slash commands,
agents with schedules/worktrees/integrations, automations with live traces,
annotation sub-browser, capabilities (integrations, skills, MCP, tools),
usage metering, audit log, cloud sync, voice mode, studio terminal.
