# Getting Started

Shiba Studio runs entirely on your machine. The only outbound traffic goes to xAI and any integrations you explicitly configure.

## Prerequisites

- **Node.js ≥ 22.5** — required for the built-in `node:sqlite` store (no native modules, nothing to compile).
- **Git** — for workspaces, worktrees, and the `/git` chat commands.
- Optional: the **Grok CLI** (`grok` on PATH), an **OpenAI-compatible local model server** (LM Studio, Ollama, llama.cpp), and **Chrome** downloads automatically via puppeteer for browser automation.

## Install

### Windows

```powershell
winget install OpenJS.NodeJS.LTS   # or: choco install nodejs-lts (ensure ≥ 22.5)
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev
```

### macOS

```bash
brew install node                  # ≥ 22.5
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev
```

### Linux

```bash
# Debian/Ubuntu via NodeSource, or use nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev
```

Open **http://localhost:3000** (or just **http://shiba.local** — the app advertises that name over mDNS and redirects bare `shiba.local` to the app port; `http://shiba.local:3000` works too). For a production build: `npm run build && npm run start`. Both bind `127.0.0.1` only — your studio is never visible to the LAN unless you explicitly use `npm run dev:lan` / `start:lan`, which also makes `shiba.local` resolve network-wide so other devices can reach it by name (read [SECURITY.md](../SECURITY.md) first).

> **Slim install:** `npm install` downloads a headless Chromium (~150 MB) for the browser-automation tools and the annotation sub-browser. If you'll never use those, install with `PUPPETEER_SKIP_DOWNLOAD=1 npm install` — everything else works, and the browser tools tell you the one command to fetch Chromium later (`npx puppeteer browsers install chrome-headless-shell`).

## First run

On a fresh install the **dashboard shows a 3-step checklist** — connect a model source → create your first agent → run it — that ticks itself off as you go and disappears when you're set up. The steps below are the same flow in detail.

1. **Connect a model source** in **Settings** — any one of:
   - **xAI API key** — from [console.x.ai](https://console.x.ai); paste and *Save & Validate*.
   - **OAuth 2.0 with X** — *Sign in with X* (SuperGrok / X Premium+): a popup opens the official `accounts.x.ai` login and closes itself when done — tokens are cached encrypted and refresh automatically, nothing to copy or paste. (A manual fallback field exists under the button if the popup can't come back.)
   - **Grok CLI** — install the `grok` binary; Shiba Studio detects it automatically and shows a `GROK CLI` badge.
   - **Local models** — enable, point at your server (e.g. `http://127.0.0.1:11434/v1` for Ollama), *Test Connection*, then choose which models are selectable.
2. Watch the **top-bar readiness badges** — one per source: `XAI TOKEN`, `OAUTH 2.0`, `GROK CLI`, `LOCAL`.
3. **Set a default model and workspace** in Settings.
4. **Say hello** — press *New Chat* in the top bar. Type `/help` to see everything chat can do.
5. **Create an agent** — Agents → *Create Agent*: pick a model, workspace, integration scopes, and optionally a schedule. Run it from the **Automations** page and watch the live execution trace.

## Where your data lives

Everything persists under `~/.shiba-studio/` (a legacy `~/.grokdesk/` from older installs is migrated there automatically):

| Path | Contents |
| --- | --- |
| `~/.shiba-studio/shiba-studio.key` | AES-256-GCM machine key (keep safe; never commit) |
| `~/.shiba-studio/data/config.json` | Settings + encrypted credentials |
| `~/.shiba-studio/data/shiba-studio.db` | SQLite: agent runs, audit log, agent memory |
| `~/.shiba-studio/data/…` | Agents, chats, projects, uploads, screenshots |

Override the data directory with `SHIBA_DATA_DIR`, the key with `SHIBA_SECRET_KEY`. See [Configuration](configuration.md).

## Troubleshooting

- **"Shiba Studio needs Node.js 22.5+"** — upgrade Node; check with `node --version`.
- **NO MODEL SOURCE badge** — no working credentials yet; open Settings.
- **LOCAL · OFFLINE badge** — local models are enabled but the server isn't responding; start LM Studio/Ollama and *Test Connection*.
- **OAuth returns HTTP 403 after login** — some X subscription tiers don't include API access; keep an API key as fallback.
- **Schedules didn't fire while the browser was closed** — they should: cron arms at *server* start (see [Automations](automations.md)). Verify the server process stayed running.
