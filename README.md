<div align="center">

<img src="public/shiba-logo.svg" alt="Shiba Studio — shiba with sunglasses logo" width="96" />

# Shiba Studio

**The localhost agent studio powered exclusively by Grok / xAI.**

Build, orchestrate, and schedule AI agents with full computer use — chat, code, browse, annotate, and automate, all from a beautiful space-themed cockpit that never leaves your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-white.svg?style=flat-square&labelColor=000)](LICENSE)
[![Node ≥ 22.5](https://img.shields.io/badge/Node-%E2%89%A5%2022.5-white.svg?style=flat-square&labelColor=000)](docs/getting-started.md)
[![Platforms](https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-supported-white.svg?style=flat-square&labelColor=000)](docs/getting-started.md)
[![Website](https://img.shields.io/badge/site-shiba--studio.io-white.svg?style=flat-square&labelColor=000)](http://shiba-studio.io)

<br/>

<img src="docs/images/chat.png" alt="Grok Chat: an element annotated in the sub-browser answered with a syntax-highlighted CSS refactor, reasoning trace, and token count" width="880" />

*Grok Chat in action — an element annotated in the sub-browser, refactored with reasoning, code, and a one-command PR.*

*Upgrading from an older install? Legacy `~/.grokdesk` data (key, credentials, runs, chats) migrates to `~/.shiba-studio` automatically on first start.*

</div>

---

## What is Shiba Studio?

Shiba Studio is a **fully local web application** (Next.js 16) that turns Grok into a hands-on engineering copilot:

- **Grok Chat** — Claude-Desktop-class chat with streaming reasoning, markdown + syntax highlighting, inline images, multimodal attachments, per-session models, and slash commands that *act* (`/git pr`, `/search`, `/note`, …). Bind any chat to a **workspace folder** (a cloned repo, say) and Grok reads, writes, and searches its files directly.
- **Agents** — autonomous workers with their own model, workspace, git worktree, integration scopes, skills, peers, and schedules. Local agents get files, shell, and a controlled Chrome; cloud agents run against Grok cloud services only.
- **Automations** — cron-scheduled agent runs with live execution traces, per-schedule run logs, and headless operation (schedules fire as long as the server is up — no browser required).
- **Annotation sub-browser** — load the web app *you're* building, click any element DevTools-style, and send its selector + HTML + highlighted screenshot straight into chat for code refinement.
- **Capabilities** — GitHub, Slack, Google Drive, Discord, X, and Obsidian integrations; custom skills; MCP servers; and a live catalog of 30+ built-in agent tools (web search, workspace grep, persistent memory, image generation, PRs, …).
- **Everything local** — credentials AES-256-GCM encrypted at rest, runs + audit trail in an embedded SQLite database, zero telemetry.

All intelligence routes exclusively through **Grok/xAI** — cloud API key, OAuth 2.0 with X, the local Grok CLI, or any OpenAI-compatible local model server (LM Studio, Ollama, llama.cpp).

## A look around

| Mission-control dashboard | Automations with run logs |
| :---: | :---: |
| <img src="docs/images/dashboard.png" alt="Dashboard: per-source readiness badges, quick stats, and the recent agent runs table with statuses and view-answer links" /> | <img src="docs/images/automations.png" alt="Automations: scheduled agents with per-schedule run logs, Active and Paused states, and Run now" /> |
| Readiness badges for every model source, live quick stats, and recent runs with one-click answers and full execution traces. | Cron-scheduled agents with per-schedule run logs — they keep firing headless as long as the server is up. |

## Quick start

```bash
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev          # → http://localhost:3000
```

**Requirements:** Node.js ≥ 22.5 (the runs/audit database uses Node's built-in `node:sqlite` — nothing to compile on any platform). Runs on **Windows, macOS, and Linux**.

Then open **Settings** and connect a model source (any one works):

| Source | How |
| --- | --- |
| **xAI API key** | Paste your `xai-…` key from [console.x.ai](https://console.x.ai) → *Save & Validate* |
| **OAuth 2.0 with X** | *Sign in with X* → complete login at `accounts.x.ai` |
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
| [Cloud Sync](docs/sync.md) | What sync does, where snapshots live, push/pull semantics |
| [Configuration](docs/configuration.md) | Settings reference, environment variables, data locations, security model |
| [Development](docs/development.md) | Repo layout, scripts, the verification suite, architecture notes |

## Highlights

- **Slash commands with autocomplete** — type `/` in chat: `/git status|checkout|commit|pr`, `/annotate`, `/workspace`, `/search`, `/fetch`, `/remember`, `/recall`, `/note`, `/x`, `/help`.
- **Chat workspaces** — point a chat at any folder with `/workspace` (or the topbar folder button); file reads/writes/searches and `/git` commands run inside it, so "fix the failing test in this repo" just works.
- **Auto-titled chats** — a low-end model summarizes each new conversation into a title after the first exchange.
- **Run provenance everywhere** — dashboard runs, agent history, and the audit log all deep-link to full execution traces; deleted agents show a 🛸 and their automations retire themselves.
- **Usage quota** — spend is metered live from xAI responses and reported against a configurable monthly budget.
- **Cross-session agent memory** — agents (and chat, via `/remember`) persist facts in SQLite and recall them in later runs.
- **Grok CLI deep integration** — route chats through the local CLI, and give agents `grok_cli` with effort levels, self-verification, best-of-N, and structured JSON output.

## Security — credentials at rest

All credentials (xAI API key, OAuth tokens, integration secrets) are **encrypted with AES-256-GCM** before touching disk. The machine key lives outside the project at `~/.shiba-studio/shiba-studio.key` (or supply `SHIBA_SECRET_KEY` as 64 hex chars for headless deployments). Secrets never appear in source code; plaintext stores migrate to encrypted form automatically on first load. See [Configuration](docs/configuration.md) for the full model and current limitations before exposing the server beyond localhost.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm test` | Full functional verification suite (theme, runtime, OAuth, features) |

## Contributing & support

- 🌐 **Website & docs** → [shiba-studio.io](http://shiba-studio.io)
- 🐛 **Bugs / feature requests** → [open an issue](https://github.com/stevologic/shiba-studio/issues/new)
- 🗺️ **Roadmap to public release** → [TODO.md](TODO.md)
- Ð **Donate Dogecoin** → `DTW2M5oEW97WbmYJRM71qD7uE6xfJs1MUK` (much thanks, very wow)

## License

[MIT](LICENSE) — free to use, fork, and ship. Much freedom. Very open source.
