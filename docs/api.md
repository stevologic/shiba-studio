# API Reference

Shiba Studio is driven entirely by its own local HTTP API (Next.js route
handlers under `app/api/*`). Everything the UI does — listing agents, streaming
runs, saving config — is a call you can make yourself.

> **Try it live.** Open **[http://127.0.0.1:3000/api-docs](http://127.0.0.1:3000/api-docs)**
> while the app is running for an **interactive explorer** that sends real
> requests against your instance and shows the responses. (It must be served
> from the app's own origin — see Access & security below.)

<img src="images/api-docs.png" alt="API Explorer at /api-docs: endpoints grouped by concern with GET/POST badges and a live request/response panel" width="880" />

## Access & security

- **Base URL:** `http://127.0.0.1:3000` (whatever host/port you run on).
- **Same-origin only.** `proxy.ts` rejects any `/api/*` request whose `Origin`
  is not loopback, and any cross-site navigation. Requests from another website
  in your browser get **403**. Calls from `curl`/scripts (no `Origin` header)
  and from the app's own pages are allowed. This is why the interactive
  explorer lives inside the app rather than on the docs site.
- **No auth tokens.** The API is unauthenticated by design (single-user,
  localhost). Do not expose it beyond localhost without your own auth in front.
- **Responses are JSON** unless noted (streams are SSE; backup is a file
  download). Most return `{ ok: true, ... }`; errors return a non-2xx status
  with `{ error }` or `{ ok: false, error }`.

### curl example

```bash
curl -s http://127.0.0.1:3000/api/version | jq
curl -s "http://127.0.0.1:3000/api/runs?limit=5" | jq
curl -s -X POST http://127.0.0.1:3000/api/config \
  -H 'Content-Type: application/json' \
  -d '{"dailyBudgetUsd": 10}'
```

## Endpoints

### Status & metadata

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/version` | Running commit/version. `?checkUpdate=1` also probes GitHub releases (cached 6 h). |
| GET | `/api/boot` | Boot ping — hydrates config and arms schedules (idempotent; carries the live commit). |
| GET | `/api/nav-stats` | Sidebar counts: chats, projects, workspace files, schedules, integrations, usage cost, `cloudReachable`. |
| GET | `/api/models` | Selectable models (cloud + local) and cloud-auth flags. |
| GET | `/api/tools` | The full built-in tool catalog with groups and scope requirements. |

### Configuration

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Settings with secrets masked, auth flags, secret-key location. |
| POST | `/api/config` | Update settings. Body is a partial config, e.g. `{ "usageBudgetUsd": 50 }`, `{ "toolApprovalMode": "ask" }`, `{ "dailyBudgetUsd": 10, "budgetHardStop": true }`, `{ "action": "testLocalGrok", "localGrokBaseUrl": "…" }`. |
| GET | `/api/integrations` | Stored integration credentials + channel-listener status. |
| POST | `/api/integrations` | `{ action: 'save'\|'delete'\|'test', which, creds }` — save/remove/test one integration. |

### Agents, runs & scheduling

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents` | All agents (models, workspaces, scopes, skills, schedules). |
| POST | `/api/agents` | `{ action: 'create'\|'update'\|'delete', … }` — manage agents. |
| POST | `/api/agents/cloud-sync` | Import cloud (Grok) agents from your xAI account. |
| GET | `/api/runs` | Run summaries. Filters: `?agentId`, `?scheduleId`, `?scheduledOnly=1`, `?limit`. `?id=<runId>` returns one run **with its full trace**. |
| GET | `/api/scheduler` | Armed cron schedules. |
| POST | `/api/scheduler` | Update an agent's schedule (`{ agentId, cron, enabled }`). |
| POST | `/api/execute` | Run an agent once (non-streaming); returns the finished run. |
| POST | `/api/execute/stream` | Run an agent with a live **SSE** trace (`{ agentId, prompt, … }`). |
| POST | `/api/execute/approve` | Approve/deny a pending tool call (`{ approvalId, approved }`). |

### Chat

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/api/chat-sessions` | List / create / update / delete chat sessions. |
| POST | `/api/grok/stream` | Stream a chat turn (SSE) — the main chat endpoint. |
| POST | `/api/grok/multi-agent-stream` | "All agents" group chat with synthesis (SSE). |
| POST | `/api/grok-cli/stream` | Stream a chat turn routed through the local **Grok CLI** (SSE). See [CLI](cli.md). |
| GET | `/api/grok-cli/status` | Grok CLI detection: installed, version, path, models. `?checkUpdate=1` checks for a newer CLI. |
| POST | `/api/chat-tools` | Run a chat slash-command tool (`/git`, `/search`, `/note`, …). |
| POST | `/api/chat/upload` | Attach files/images to a chat. |
| POST | `/api/tts` | Text-to-speech (xAI voices). |

### Observability

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/search` | Global FTS5 search across chats, runs, and the audit log (`?q=`). |
| GET | `/api/logs` | Audit log, paginated (`?q`, `?category`, `?limit`, `?offset`). |
| GET | `/api/usage` | Usage & cost summary (studio metering + optional xAI billing backport). |

### Workspace, projects & files

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/api/workspace` | List files (`?dir=`); POST `{ action: 'read', path }` or `{ path, content }` to write. |
| GET | `/api/workspace/diff` | Working-tree diff for a workspace. |
| GET | `/api/workspace/worktrees` | Git worktrees for an agent workspace. |
| POST | `/api/workspace/sync`, `/api/workspace/upload`, `/api/workspace/cloud-file`, `/api/workspace/context` | Global uploads, cloud sync, and context assembly. |
| GET | `/api/fs/browse` | Folder browser — subdirectories of `?dir=` (git repos badged). |
| GET/POST | `/api/projects`, `/api/projects/context`, `/api/projects/upload` | Project CRUD, context, and file uploads. |
| POST | `/api/git` | Git actions (status/checkout/commit/pr) against a workspace. |

### Integrations & capabilities

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/api/obsidian` | Test/list/read/write/search an Obsidian vault. |
| GET/POST | `/api/google-drive/folders` | List Drive folders for per-agent scoping. |
| GET/POST | `/api/skills` | Built-in + custom skills; create/edit/assign. |
| GET/POST | `/api/mcp` | Configured MCP servers; add/enable/remove. |
| GET/POST | `/api/subbrowser`, `/api/subbrowser/stream` | The annotation sub-browser (navigate, annotate, screenshot). |
| GET/POST | `/api/terminal` | Studio terminal session info and control. |

### OAuth (browser-driven)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/xai-oauth/start` | Begin X OAuth (returns the authorize URL). |
| GET | `/api/xai-oauth/callback` | Loopback/manual callback hand-back page. |
| POST | `/api/xai-oauth/exchange` | Exchange the code for tokens. |
| GET | `/api/xai-oauth/status` | OAuth connection status. |
| POST | `/api/xai-oauth/logout` | Disconnect OAuth. |
| GET/POST | `/api/google-oauth/start`, `/api/google-oauth/callback` | Google Drive OAuth. |

### Backup & sync

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/backup` | Download a full studio backup (JSON incl. encryption key; `?key=omit` to exclude it). |
| POST | `/api/backup` | Restore a backup bundle (posted as the JSON body). |
| GET/POST | `/api/cloud/entities` | Cloud-sync entity snapshots (push/pull). |

## Streaming (SSE) endpoints

`/api/execute/stream`, `/api/grok/stream`, `/api/grok/multi-agent-stream`,
`/api/grok-cli/stream`, and `/api/subbrowser/stream` return
`text/event-stream`. Each event is a `data: <json>` line; consume with the
browser `EventSource`/`fetch` reader. Event shapes are defined in
`lib/agent-stream-types.ts` (agent runs) and `lib/chat-types.ts` (chat).

```bash
# Watch an agent run's trace stream
curl -N -X POST http://127.0.0.1:3000/api/execute/stream \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<id>","prompt":"List the files and summarize the project."}'
```
