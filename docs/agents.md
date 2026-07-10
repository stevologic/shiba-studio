# Agents

Agents are autonomous Grok workers with their own model, workspace, capabilities, and schedules. The **Agents page** is where you view, create, and edit them; running and traces live on **[Automations](automations.md)**.

<img src="images/agents.png" alt="Agents page: local and cloud Grok agents with models, workspaces, integration scopes, skills, and schedule state" width="880" />

## Local vs cloud agents

| | Local agent | Cloud agent |
| --- | --- | --- |
| Files & shell in workspace | ✅ | ❌ |
| Browser automation (Chrome) | ✅ | ❌ |
| Grok CLI delegation, MCP tools | ✅ | ❌ |
| Cloud integrations (GitHub, Slack, …) | ✅ | ✅ |
| Web research, memory, scheduling | ✅ | ✅ |

Cloud agents are labeled `CLOUD` and are safe to sync from your xAI account (*Sync cloud agents* imports heavy Grok cloud agents in one click).

## Anatomy of an agent

- **Model** — any Cloud (xAI) or Local model; a provider badge shows which.
- **Workspace** — the directory the agent works in. Enable **worktree** to give every run an isolated git worktree of the repo instead of the live checkout.
- **Integration scopes** — per-agent switches for GitHub, Slack, Google Drive, Discord, X, Obsidian, Vercel, and Netlify. A scope both unlocks the matching tools *and* injects live context (an Obsidian-scoped agent gets its vault's contents in every run and chat; Vercel/Netlify-scoped agents see projects/sites and can deploy).
- **Skills** — reusable prompt capabilities from the Capabilities page, plus a free-form *chat Skill* that defines the agent's voice when you chat as it.
- **Peers** — other agents it may message via `send_to_peer`; inboxes drain at the start of the next run.
- **Schedules** — cron entries with their own instructions (see [Automations](automations.md)).

## The agent card

Each card shows model, origin, scopes, skills, workspace, and schedule state, plus:

- **Edit** — the full configuration modal.
- **Terminal icon** — jump to Automations (runs, traces, run-now).
- **History icon** — every past run with status, timestamps, step counts, and *answer* quick-views; click a run for its full execution trace.
- **Delete** — removes the agent; its schedules retire automatically and historical runs show a 🛸 avatar.

## Tools

Agents act through a tool-calling loop (up to 18 steps per run). The full catalog — workspace files & shell, browser automation, web research, persistent memory, image generation, integrations, orchestration, MCP — is documented on the **Capabilities page** in-app and in [Capabilities](capabilities.md). Tool approval defaults to **Ask before act** (each sensitive tool call is confirmed); *YOLO* auto-run is an explicit opt-in under Settings → Agent Behavior.

Small local models (llama.cpp/Ollama) that print a tool call as text instead of using the structured field still work — the runtime recovers the inline call and executes it. Cloud runs and chats are also bounded by the **Cost & safety** limits (concurrent-run cap, monthly/daily spend hard stop, per-run token cap) and overlapping scheduled runs are skipped — see [Configuration](configuration.md).

## Memory

Agents remember across runs: `memory_save(key, content)` persists facts in SQLite, `memory_recall(query?)` retrieves them at the start of later runs. Memory is per-agent; chat has its own shared scope via `/remember` and `/recall`.
