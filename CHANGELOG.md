# Changelog

All notable changes to Shiba Studio. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[semver](https://semver.org/). Upgrades are safe in place: the SQLite store
migrates itself (`PRAGMA user_version` ladder) and legacy data directories
are carried over automatically.

## [Unreleased]

### Changed

- **Weekly maintain can read ChatGPT/Codex docs.** `fetch_url` now allows
  `learn.chatgpt.com`, prefers Markdown/`text/plain`, extracts prose from
  JS app shells, and rejects redirects off the host allowlist. Workflow
  write fences on `GITHUB_TOKEN` are unchanged.
- **Reddit Devvit bridge lockfile pins.** `js-yaml` 4.x is now 4.3.1,
  `nanoid` is 3.3.18, and `hono` is 4.13.3 so the subpackage no longer
  ships the previously reported high `js-yaml`/`nanoid` advisories.
  `postcss` and `brace-expansion` 1.x/2.x are pinned to patched releases.
- **Root advisory pins.** `hono` is overridden to 4.13.3 and Next's bundled
  `postcss` to 8.5.26 so root `npm audit` is clean at every severity.

### Fixed

- **Windows store-lock waits under contention.** Multi-process Board/agent
  writes share `.ownership-stores`; the lock wait (and the concurrency
  verifier child) now allows 60s/120s on Windows so Node 24 CI does not
  flake at the old 30s ceiling.
- **Grok issue automation can push again.** Agents are fenced off
  `.github/workflows/*` because `GITHUB_TOKEN` cannot update workflow files
  (run 31644453870 failed the push, then closed the issue as if nothing
  changed). Workflow-only edits are dropped; a failed push is labeled
  `grok-failed` and no longer closes the issue.
- **Self-heal builds before `npm test`.** The healer gate now runs
  `npm run build` so `verify-theme` has a production `.next` and binds
  `127.0.0.1` instead of hanging when the build is missing.

### Added

- **Grok issue automation** — a GitHub Action addresses issues filed by
  repo admins or by enabled project automations (Actions, Dependabot, other
  bots). Missing `GROK_API_KEY` skips. Fixes land on `development` and ride
  the existing CI OK → promote path.
- **Grok phone assistant** — Settings pairs a Voice Agent Builder / SIP
  number to this Studio. Spoken commands hit a signed public MCP and JSON
  command path and run the real server-side Board, git, memory, search, and
  durable-work actions (logged in a Phone assistant chat). Incoming SIP
  webhooks can join the Speech-to-Speech session with the same tools.
- **Hands-off Grok 4.6+ maintenance** — daily high/critical vulnerability
  remediation and a Monday weekly pass that assesses Claude / ChatGPT-Codex /
  Grok / Cursor (plus self-improvement of the automation). Both write only to
  `development`; existing **CI OK** + promote still auto-merges to `main`.
  Missing `GROK_API_KEY` skips the agent with a warning.
- **Grok 4.6 is the studio default.** New chats, agents, meetings, and offline
  fallback catalogs use `cloud:grok-4.6`. The picker prefers the current
  flagship instead of the leftover `grok-4` id. Usage metering uses the
  published 4.6/4.5 rates ($2 / $6 per million) and the 200k long-context
  multiplier. Long sessions replay a model-aware context budget (40k tokens
  on 4.6 vs 14k previously).
- **Failure & skip notices** — scheduled skips and failed/lost tasks appear
  in the top-bar bell as dismissable alerts, with optional desktop
  notifications. Approvals stay an exact-action queue.
- **Studio health in Settings** — run Doctor and apply previewed repairs
  without a `/doctor` route.
- Durable peer-agent inbox (survives a server restart).
- **Code IDE** — a dedicated Monaco editor with multi-file tabs, repository
  search, diagnostics, structured Git staging/branches/history, live GitHub
  pull requests/issues/workflows, access to the persistent host terminal, and
  a picker for the default workspace, saved projects, and Git worktrees.
- Workspace-contained file APIs and argument-safe Git operations for IDE use.
- **Meetings (Beta)** — spoken, agent-led project reviews with a visual stage
  (real workspace code, diagrams, markdown, live screenshots), streaming turns
  over SSE, AI steering chips, and minutes that convert to Board cards after
  confirmation. Mid-meeting, the director can create real Board work in the
  same turn ("make a card", "queue it", "have <agent> fix it") with click-to-
  Board transcript chips; minutes skip already-created items so cards are not
  doubled.
- **Rich cards** — fenced `shiba-card` JSON renders as stats, progress,
  checklists, timelines, callouts, media, sparklines, bars, and multi-series
  timecharts in chat, meetings, and run output. Agents choose presentation
  (prose vs table vs card) and can compose a **custom** card from declarative
  primitives (text, badge, kv, meter, divider, nestable row/grid) with hard
  depth and element budgets — JSON only, never HTML.
- **Board Timeline (Gantt)** — delivered-work view of Done cards under the
  current project filter (created → done bars from activity).
- **Board search** — header filter by SHIB key (`SHIB-12`, bare number) or free
  text over title, description, and labels; stacks with the project filter.
- **Queue work** — when an assignee is already busy, Start work records a
  durable queued pending assignment instead of refusing; the processor starts
  it when the agent frees up. Queued cards show a badge and support Leave queue.
- **Approvals alert bell** — pending approvals live in a top-bar bell with a
  count badge and in-place approve/deny (the Attention primary-nav tab is
  retired; `/attention` 404s).
- **Brand assets** — real favicon, iOS home-screen icon, and Open Graph /
  link-unfurl card.
- **Chat resilience** — queue additional messages while a reply streams; pin
  stick-to-bottom through growing reasoning; longer timeouts for tool-heavy
  turns; transport/proxy failures surface as short recovery copy instead of
  HTML dumps.
- **Reverse-proxy deployment** — documented `SHIBA_PUBLIC_ORIGIN` path for TLS
  termination and auth at the proxy while Studio stays on loopback; chat
  isolation hardened for shared-origin setups.
- **serveLocalName** — runtime control for mDNS / port-80 local-name advertising.

### Changed

- Self-heal now defaults to Grok 4.6, can apply surgical file edits, and
  must pass `npm test` (not only `tsc`) before pushing. Development CI no
  longer cancels an in-flight heal/promote. Promotion PRs no longer
  force-merge when auto-merge cannot be enabled.
- Lint on `lib/`, `app/api/`, `scripts/`, and `types/` is a required CI
  check. Component lint remains non-blocking.
- Pin patched `brace-expansion`, `minimatch`, `fast-uri`, `ip-address`,
  `js-yaml`, and `nanoid` via npm overrides so `npm audit --audit-level=high`
  stays clean.
- Approvals moved out of the primary nav into the shell top bar so the slot is
  not spent on a usually-empty queue.
- Board assignment UX distinguishes **Start work** (run now) from **Queue work**
  (run when free), including operator-consented queueing for agents that have
  not enabled auto-accept.

### Fixed

- Interrupting a meeting agent no longer lets an in-flight greeting TTS chunk
  play after stop; speech chunks carry an epoch so barge-in (including mic on)
  drops stale audio.
- Tracked global uploads are served at `/uploads/<name>` (capability-gated like
  `/api/files`), so agent-cited images in chat render instead of 404ing.
- Meetings and chat no longer double-fetch projects/agents/models on mount;
  shared client JSON load uses a short reuse window.
- Rich-card type narrowing and stream error UX for queued chat turns.
- Grok CLI no longer passes `--check` when subagents are disabled.
- CI path canonicalization and dependency audit cleanups across platforms.


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
- **Agents were sent an empty tool list on every run** (`filterToolsByDisabled`
  aliased its input; the runtime then reset it in place) — the model never
  learned its tools existed. Now fixed for both agent runs and chat.
- Local models that print tool calls as text (llama.cpp/Ollama) now work —
  the runtime recovers the inline call instead of treating it as the answer.
- `/capabilities` resolves to the Capabilities tab instead of the dashboard.
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
