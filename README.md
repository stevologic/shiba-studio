<div align="center">

# 🐕 Shiba Studio

**The localhost agent studio powered exclusively by Grok / xAI.**

Build, orchestrate, and schedule AI agents with full computer use — chat, code, browse, annotate, and automate, all from a beautiful space-themed cockpit that never leaves your machine.

*Formerly "GrokDesk" — internal paths (`~/.grokdesk/`, `GROKDESK_*` env vars) keep the old name so existing data keeps working.*

</div>

---

## What is Shiba Studio?

Shiba Studio is a **fully local web application** (Next.js 16) that turns Grok into a hands-on engineering copilot:

- **Grok Chat** — Claude-Desktop-class chat with streaming reasoning, markdown + syntax highlighting, inline images, multimodal attachments, per-session models, and slash commands that *act* (`/git pr`, `/search`, `/note`, …).
- **Agents** — autonomous workers with their own model, workspace, git worktree, integration scopes, skills, peers, and schedules. Local agents get files, shell, and a controlled Chrome; cloud agents run against Grok cloud services only.
- **Automations** — cron-scheduled agent runs with live execution traces, per-schedule run logs, and headless operation (schedules fire as long as the server is up — no browser required).
- **Annotation sub-browser** — load the web app *you're* building, click any element DevTools-style, and send its selector + HTML + highlighted screenshot straight into chat for code refinement.
- **Capabilities** — GitHub, Slack, Google Drive, Discord, X, and Obsidian integrations; custom skills; MCP servers; and a live catalog of 30+ built-in agent tools (web search, workspace grep, persistent memory, image generation, PRs, …).
- **Everything local** — credentials AES-256-GCM encrypted at rest, runs + audit trail in an embedded SQLite database, zero telemetry.

All intelligence routes exclusively through **Grok/xAI** — cloud API key, OAuth 2.0 with X, the local Grok CLI, or any OpenAI-compatible local model server (LM Studio, Ollama, llama.cpp).

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

- **Slash commands with autocomplete** — type `/` in chat: `/git status|checkout|commit|pr`, `/annotate`, `/search`, `/fetch`, `/remember`, `/recall`, `/note`, `/help`.
- **Auto-titled chats** — a low-end model summarizes each new conversation into a title after the first exchange.
- **Run provenance everywhere** — dashboard runs, agent history, and the audit log all deep-link to full execution traces; deleted agents show a 🛸 and their automations retire themselves.
- **Usage quota** — spend is metered live from xAI responses and reported against a configurable monthly budget.
- **Cross-session agent memory** — agents (and chat, via `/remember`) persist facts in SQLite and recall them in later runs.
- **Grok CLI deep integration** — route chats through the local CLI, and give agents `grok_cli` with effort levels, self-verification, best-of-N, and structured JSON output.

## Security — credentials at rest

All credentials (xAI API key, OAuth tokens, integration secrets) are **encrypted with AES-256-GCM** before touching disk. The machine key lives outside the project at `~/.grokdesk/grokdesk.key` (or supply `GROKDESK_SECRET_KEY` as 64 hex chars for headless deployments). Secrets never appear in source code; plaintext stores migrate to encrypted form automatically on first load. See [Configuration](docs/configuration.md) for the full model and current limitations before exposing the server beyond localhost.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm test` | Full functional verification suite (theme, runtime, OAuth, features) |

## Contributing & support

- 🐛 **Bugs / feature requests** → [open an issue](https://github.com/stevologic/shiba-studio/issues/new)
- 🗺️ **Roadmap to public release** → [TODO.md](TODO.md)
- Ð **Donate Dogecoin** → `DTW2M5oEW97WbmYJRM71qD7uE6xfJs1MUK` (much thanks, very wow)

## Doge easter egg

Settings → *Activate Doge Shiba Inu Page Icon* — instantly swaps the favicon and persists. 🐶
