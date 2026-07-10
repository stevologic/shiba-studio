<div align="center">

<img src="public/shiba-logo.svg" alt="Shiba Studio — shiba with sunglasses logo" width="96" />

# Shiba Studio

**The localhost agent studio powered exclusively by Grok / xAI.**

Build, orchestrate, and schedule AI agents with full computer use — chat, code, browse, annotate, and automate, all from a beautiful space-themed cockpit that never leaves your machine.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-white.svg?style=flat-square&labelColor=000)](LICENSE-AGPL-3.0)
[![Commercial available](https://img.shields.io/badge/Commercial-available-white.svg?style=flat-square&labelColor=000)](LICENSE-COMMERCIAL.md)
[![Node ≥ 22.5](https://img.shields.io/badge/Node-%E2%89%A5%2022.5-white.svg?style=flat-square&labelColor=000)](docs/getting-started.md)
[![Platforms](https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-supported-white.svg?style=flat-square&labelColor=000)](docs/getting-started.md)
[![Website](https://img.shields.io/badge/site-shiba--studio.io-white.svg?style=flat-square&labelColor=000)](http://shiba-studio.io)

<br/>

<img src="docs/images/chat.png" alt="Grok Chat: annotated sub-browser element request with selector, HTML snippet, and mic-enabled composer" width="880" />

*Grok Chat in action — annotate the app you're building, refine with Grok, dictate messages, and ship from the same session.*

*Upgrading from an older install? Legacy `~/.grokdesk` data (key, credentials, runs, chats) migrates to `~/.shiba-studio` automatically on first start.*

</div>

---

## What is Shiba Studio?

Shiba Studio is a **fully local web application** (Next.js 16) that turns Grok into a hands-on engineering copilot:

- **Grok Chat** — Claude-Desktop-class chat with streaming reasoning, markdown + syntax highlighting, inline images, multimodal attachments, per-session models, and slash commands that *act* (`/git pr`, `/search`, `/note`, …). Bind any chat to a **workspace folder** (a cloned repo, say) and Grok reads, writes, and searches its files directly.
- **Agents** — autonomous workers with their own model, workspace, git worktree, integration scopes, skills, peers, and schedules. Local agents get files, shell, and a controlled Chrome; cloud agents run against Grok cloud services only.
- **Automations** — cron-scheduled agent runs with live execution traces, per-schedule run logs, and headless operation (schedules fire as long as the server is up — no browser required).
- **Annotation sub-browser** — load the web app *you're* building, click any element DevTools-style, and send its selector + HTML + highlighted screenshot straight into chat for code refinement.
- **Capabilities** — GitHub, Slack, Google Drive, Discord, X, Obsidian, Vercel, and Netlify integrations; custom skills; MCP servers; and a live catalog of 40+ built-in agent tools (web search, workspace grep, persistent memory, image generation, PRs, deploys, …).
- **Everything local** — credentials AES-256-GCM encrypted at rest, runs + audit trail in an embedded SQLite database, one-file backup & restore, and zero telemetry.

All intelligence routes exclusively through **Grok/xAI** — cloud API key, OAuth 2.0 with X, the local Grok CLI, or any OpenAI-compatible local model server (LM Studio, Ollama, llama.cpp).

## A look around

| Mission-control dashboard | Automations with run logs |
| :---: | :---: |
| <img src="docs/images/dashboard.png" alt="Dashboard: hero, readiness badges, quick stats, and recent agent runs with statuses and view-answer links" /> | <img src="docs/images/automations.png" alt="Automations: scheduled agents with Active/Paused states, per-schedule Run/Edit/Delete, and compact run-log icon" /> |
| Readiness badges for every model source, live quick stats, and recent runs with one-click answers and full execution traces. | Cron-scheduled agents with compact run-log access — they keep firing headless as long as the server is up. |

## Quick start

```bash
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev          # → http://127.0.0.1:3000 (localhost only, by design)
```

**Requirements:** Node.js ≥ 22.5 (the runs/audit database uses Node's built-in `node:sqlite` — nothing to compile on any platform). Runs on **Windows, macOS, and Linux**.

Then open **Settings** and connect a model source (any one works):

| Source | How |
| --- | --- |
| **xAI API key** | Paste your `xai-…` key from [console.x.ai](https://console.x.ai) → *Save & Validate* |
| **OAuth 2.0 with X** | *Sign in with X* → a popup opens `accounts.x.ai`, then closes itself — tokens cached & auto-refreshed, nothing to paste |
| **Grok CLI** | Install the `grok` CLI — detected automatically from PATH |
| **Local models** | Enable local models and point at any OpenAI-compatible server |

The top bar shows a readiness badge for each source.

## Documentation

| Guide | Covers |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Install on Windows/macOS/Linux, first run, connecting model sources |
| [Grok Chat](docs/chat.md) | Sessions, models & reasoning, attachments, slash commands, the annotation sub-browser, quotas |
| [Agents](docs/agents.md) | Local vs cloud agents, workspaces & worktrees, skills, peers, run history |
| [Automations](docs/automations.md) | Cron schedules, execution traces, run logs, headless operation |
| [Capabilities](docs/capabilities.md) | Integrations, skills, MCP servers, and the full built-in tool catalog |
| [Grok CLI](docs/cli.md) | Routing chat through the local `grok` CLI, the `grok_cli` agent tool, effort/check/best-of-N/structured output |
| [API Reference](docs/api.md) | Every `/api/*` endpoint, curl examples, and the in-app interactive explorer at `/api-docs` |
| [Cloud Sync](docs/sync.md) | What sync does, where snapshots live, push/pull semantics |
| [Architecture](docs/architecture.md) | How every feature fits together — one diagram, one engine |
| [Configuration](docs/configuration.md) | Settings reference, environment variables, data locations, security model |
| [Development](docs/development.md) | Repo layout, scripts, the verification suite, architecture notes |

## Highlights

- **Slash commands with autocomplete** — type `/` in chat: `/git status|checkout|commit|pr`, `/annotate`, `/workspace`, `/search`, `/fetch`, `/remember`, `/recall`, `/note`, `/x`, `/help`.
- **Chat workspaces** — point a chat at any folder with `/workspace` (or the topbar folder button); file reads/writes/searches and `/git` commands run inside it, so "fix the failing test in this repo" just works.
- **Auto-titled chats** — a low-end model summarizes each new conversation into a title after the first exchange.
- **Run provenance everywhere** — dashboard runs, agent history, and the audit log all deep-link to full execution traces; deleted agents show a 🛸 and their automations retire themselves.
- **Cost & safety guardrails** — monthly *and* daily spend limits with an optional hard stop, a global concurrent-run cap, per-run token caps, and overlap-suppressed schedules (Settings → Cost & safety).
- **Global search** — Ctrl+K searches your chats, agent runs, and audit log (SQLite FTS5) alongside commands, deep-linking straight to the result.
- **Backup & restore** — export your entire studio (settings, agents, chats, projects, runs, audit log) to one file and restore it on another machine.
- **Cross-session agent memory** — agents (and chat, via `/remember`) persist facts in SQLite and recall them in later runs.
- **Grok CLI deep integration** — route chats through the local CLI, and give agents `grok_cli` with effort levels, self-verification, best-of-N, and structured JSON output.

## Security

- **Localhost only, by default** — the server binds `127.0.0.1`; a same-origin guard (`proxy.ts`) blocks any other website in your browser from reaching the API, and the terminal bridge rejects foreign WebSocket origins. `npm run dev:lan` / `start:lan` opt into LAN exposure.
- **Ask-before-act** — sensitive tools (shell, file writes, posting) require per-call approval by default; YOLO mode is an explicit opt-in.
- **Spend limits** — optional monthly/daily budgets with a hard stop pause cloud runs and chats before you overspend; local models are always free.
- **Credentials at rest** — all secrets (xAI API key, OAuth tokens, integration secrets) are **encrypted with AES-256-GCM** before touching disk; the machine key lives outside the project at `~/.shiba-studio/shiba-studio.key` (or supply `SHIBA_SECRET_KEY` as 64 hex chars for headless deployments). Plaintext stores migrate to encrypted form automatically on first load.

Full threat model and vulnerability reporting: [SECURITY.md](SECURITY.md) · Privacy: [PRIVACY.md](PRIVACY.md) · Settings reference: [Configuration](docs/configuration.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload (binds `127.0.0.1`) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build (binds `127.0.0.1`) |
| `npm run dev:lan` / `start:lan` | Explicitly expose on all interfaces — read [SECURITY.md](SECURITY.md) first |
| `npm test` | Full functional verification suite — isolated, never touches your live data |
| `npm run test:e2e` | Playwright browser E2E (run `npx playwright install chromium` + `npm run build` first) |

## Contributing & support

- 🌐 **Website & docs** → [shiba-studio.io](http://shiba-studio.io)
- 🛠️ **Contributing guide** → [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- 🐛 **Bugs / feature requests** → [open an issue](https://github.com/stevologic/shiba-studio/issues/new/choose)
- 🔒 **Security reports** → [SECURITY.md](SECURITY.md) (privately, please)
- 🗺️ **Roadmap to public release** → [TODO.md](TODO.md)
- Ð **Donate Dogecoin** → `DTW2M5oEW97WbmYJRM71qD7uE6xfJs1MUK` (much thanks, very wow)

## License

**Dual licensed:**

- **[AGPL-3.0-or-later](LICENSE-AGPL-3.0)** — open source; if you run a modified version as a network service, you must offer source to users.
- **[Commercial](LICENSE-COMMERCIAL.md)** — for closed-source / SaaS use without AGPL obligations (contact the copyright holder).

See [LICENSE](LICENSE) for the dual-license notice.
