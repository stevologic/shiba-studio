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

Open **http://localhost:3000**. For a production build: `npm run build && npm run start`.

## First run

1. **Connect a model source** in **Settings** — any one of:
   - **xAI API key** — from [console.x.ai](https://console.x.ai); paste and *Save & Validate*.
   - **OAuth 2.0 with X** — *Sign in with X* (SuperGrok / X Premium+); if the redirect fails, paste the callback URL into the manual field.
   - **Grok CLI** — install the `grok` binary; Shiba Studio detects it automatically and shows a `GROK CLI` badge.
   - **Local models** — enable, point at your server (e.g. `http://127.0.0.1:11434/v1` for Ollama), *Test Connection*, then choose which models are selectable.
2. Watch the **top-bar readiness badges** — one per source: `XAI TOKEN`, `OAUTH 2.0`, `GROK CLI`, `LOCAL`.
3. **Set a default model and workspace** in Settings.
4. **Say hello** — press *New Chat* in the top bar. Type `/help` to see everything chat can do.
5. **Create an agent** — Agents → *Create Agent*: pick a model, workspace, integration scopes, and optionally a schedule. Run it from the **Automations** page and watch the live execution trace.

## Where your data lives

Everything persists under `~/.grokdesk/`:

| Path | Contents |
| --- | --- |
| `~/.grokdesk/grokdesk.key` | AES-256-GCM machine key (keep safe; never commit) |
| `~/.grokdesk/data/config.json` | Settings + encrypted credentials |
| `~/.grokdesk/data/grokdesk.db` | SQLite: agent runs, audit log, agent memory |
| `~/.grokdesk/data/…` | Agents, chats, projects, uploads, screenshots |

Override the data directory with `GROKDESK_DATA_DIR`, the key with `GROKDESK_SECRET_KEY`. See [Configuration](configuration.md).

## Troubleshooting

- **"Shiba Studio needs Node.js 22.5+"** — upgrade Node; check with `node --version`.
- **NO MODEL SOURCE badge** — no working credentials yet; open Settings.
- **LOCAL · OFFLINE badge** — local models are enabled but the server isn't responding; start LM Studio/Ollama and *Test Connection*.
- **OAuth returns HTTP 403 after login** — some X subscription tiers don't include API access; keep an API key as fallback.
- **Schedules didn't fire while the browser was closed** — they should: cron arms at *server* start (see [Automations](automations.md)). Verify the server process stayed running.
