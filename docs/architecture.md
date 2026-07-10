# Architecture — how the features fit together

Every surface in Shiba Studio funnels into the same small engine: one model
gateway, one tool executor, one SQLite store, one audit trail. The diagram
below shows the real interaction paths (GitHub renders it inline).

```mermaid
flowchart TB
    subgraph Surfaces["Surfaces — what you touch"]
        Chat["Grok Chat<br/>slash commands + autocomplete"]
        SubBrowser["Annotation sub-browser<br/>interact / annotate / scroll"]
        Workspace["Chat workspace<br/>bind a folder or repo"]
        AgentsUI["Agents page<br/>create / edit / configure"]
        AutomationsUI["Automations page<br/>per-schedule pills, run log, live trace"]
        Dashboard["Dashboard<br/>readiness badges, recent runs"]
        LogsUI["Logs page<br/>audit trail, deep links"]
    end

    subgraph Engine["Engine — what does the work"]
        Gateway["Model gateway (grok-client)<br/>xAI key / OAuth / Grok CLI / local server"]
        ToolExec["Tool executor<br/>30+ tools: fs, shell, browser, web,<br/>memory, images, PRs, MCP"]
        Runtime["Agent runtime<br/>tool-calling loop + trace"]
        Scheduler["Scheduler (node-cron)<br/>armed at server start, headless"]
    end

    subgraph Capabilities["Capabilities — what it can reach"]
        Integrations["Integrations<br/>GitHub, Slack, Drive, Discord, X, Obsidian, Vercel"]
        Skills["Custom skills"]
        MCP["MCP servers"]
        Git["Git actions<br/>status / checkout / commit / PR"]
    end

    subgraph Storage["Storage — what it remembers"]
        SQLite[("SQLite (~/.shiba-studio)<br/>runs + traces, audit log,<br/>agent memory, schedule ticks")]
        Config[("config.json<br/>credentials sealed AES-256-GCM")]
        Sync["Cloud sync<br/>snapshots in your xAI file storage"]
    end

    Chat -->|"messages + tool loop"| Gateway
    Chat -->|"/git /x /search /note …"| ToolExec
    Chat -->|"/annotate"| SubBrowser
    Chat -->|"/workspace"| Workspace
    Workspace -->|"fs tools rooted in the folder"| ToolExec
    SubBrowser -->|"selector + HTML + screenshot"| Chat
    SubBrowser -->|"headless Chrome"| ToolExec

    AgentsUI -->|"defines agents, scopes, schedules"| Runtime
    AutomationsUI -->|"Run now + pause/edit/delete per cron"| Scheduler
    Scheduler -->|"tick claim in SQLite, then run"| Runtime
    Runtime <-->|"thoughts + tool calls"| Gateway
    Runtime -->|"executes"| ToolExec
    Runtime -->|"schedule_task / send_to_peer"| Scheduler

    ToolExec --> Integrations
    ToolExec --> Git
    ToolExec --> MCP
    Skills -->|"injected into prompts"| Runtime

    Runtime -->|"runs + traces"| SQLite
    ToolExec -->|"agent memory"| SQLite
    Integrations -->|"credentials"| Config
    Config --> Sync

    SQLite --> Dashboard
    SQLite --> AutomationsUI
    SQLite --> LogsUI
```

## Reading the map

- **Everything speaks through one gateway.** Chat turns, agent runs, and
  auto-titling all route through `lib/grok-client` — whichever model source is
  connected (xAI API key, OAuth 2.0 with X, the Grok CLI, or a local
  OpenAI-compatible server). The dashboard's readiness badges report exactly
  these four routes.
- **One tool executor, many callers.** The chat tool loop, agent runs, and
  slash commands all execute through `lib/agent-tool-exec` — so a tool behaves
  identically whether chat called it, a scheduled run called it, or you typed
  a slash command. Cloud-origin agents are blocked from machine tools; a chat
  workspace binding explicitly grants the fs tools for that folder only.
- **The scheduler is process-safe.** Cron arms once at server start
  (`instrumentation.ts`), state is shared across module copies, and every fire
  atomically claims its minute tick in SQLite — duplicate tasks or extra
  server processes skip instead of double-running.
- **Everything lands in the audit log.** Runs, chats, tool calls, config
  changes, git actions, sync — the Logs page reads the same SQLite trail and
  deep-links back into full execution traces.

For file-level details see [Development](development.md); for the data
locations and security model see [Configuration](configuration.md).
