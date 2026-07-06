# GrokDesk — Grok Agent Platform (localhost)

Fully functional Claude/Cursor/Codex-style agent studio powered **exclusively** by Grok + xAI.

- Run locally with `npm run dev` or `npm run build && npm run start`
- Visual multi-agent builder + orchestrator + scheduler
- Real local workspace + git worktree support
- Chrome/browser computer-use control (navigate, click, type, screenshot, extract)
- Full tool calling loop using Grok models
- Core integrations: GitHub, Slack, Google Drive (config + callable by agents)
- Agents have own model, workspace, scoped integrations, schedules, peers
- Inter-agent messaging + self-scheduling
- Claude-Desktop-class chat: GitHub-flavored markdown, syntax-highlighted code blocks with copy buttons, tables, streaming reasoning traces, stop/regenerate, multi-line composer (Shift+Enter), model picker in the composer bar
- **Local + cloud agents** — local agents get full machine access (files, shell, browser, worktrees, MCP); cloud agents run against Grok cloud services only and are labeled `CLOUD AGENT`. One click syncs heavy Grok cloud agents from your xAI account
- **Cloud sync with progress** — the top-bar Sync opens a modal that pushes/pulls agents, automations, projects, chats, workspace uploads (and local model settings when in use) through your xAI cloud file store, with per-item status and a progress bar
- Rename/delete projects, chats, and automations from the left nav quick-access and inside each section
- Zero OS popups — all confirmations are in-app dialogs; every modal dismisses when you click outside it; agent automation runs headless (no browser windows)
- Usage & Cost dashboard metered live from xAI API responses, with a live api.x.ai connection indicator
- Beautiful professional + fun dark UI (logo click returns to Dashboard)
- Doge Shiba Inu easter egg in Settings

## Quick Start (Fully Functional Out of Box)

1. `npm install`
2. `npm run dev`
3. Open http://localhost:3000
4. Go to **Settings** and configure cloud Grok (either option works):
   - **xAI API key** — paste your `xai-...` key → Save & Validate, or
   - **Sign in with X (OAuth)** — click **Sign in with X**, complete login at `accounts.x.ai` (the app tab updates automatically when connected; paste the callback URL if redirect fails)
5. Create Agents (choose model, workspace path, enable worktree, pick scopes + peers + cron)
6. Press **Run** on any agent
7. Watch live trace, screenshots, file changes, shell, browser actions
8. Schedule agents, let them message each other, use Drive/Slack/GitHub when configured

All intelligence routes exclusively through Grok/xAI.

## Commands
- `npm run dev`
- `npm run build`
- `npm run start`
- `npm test`

## Security — credentials at rest

All credentials (xAI API key, OAuth tokens, integration secrets) are **encrypted at rest with AES-256-GCM** before touching disk. The encryption key lives outside the project at `~/.grokdesk/grokdesk.key` (or supply `GROKDESK_SECRET_KEY` as 64 hex chars for headless deployments) — secrets never appear in source code, and the `data/` directory is additionally gitignored. Existing plaintext stores are migrated to encrypted form automatically on first load.

## Doge Easter Egg
Settings → "Activate Doge Shiba Inu Page Icon" — instantly swaps favicon and persists.

## Use for building tools
Perfect base to build other agents, automation pipelines, and full apps using Grok + local execution.

Created to be an instant competitor and future desktop-app candidate.

