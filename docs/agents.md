# Agents

Agents are autonomous Grok workers with their own model, workspace, capabilities, and schedules. The **Agents page** is where you view, create, and edit them; running and traces live on **[Automations](automations.md)**.

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
- **Integration scopes** — per-agent switches for GitHub, Slack, Google Drive, Discord, X, and Obsidian. A scope both unlocks the matching tools *and* injects live context (an Obsidian-scoped agent gets its vault's contents in every run and chat).
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

Agents act through a tool-calling loop (up to 18 steps per run). The full catalog — workspace files & shell, browser automation, web research, persistent memory, image generation, integrations, orchestration, MCP — is documented on the **Capabilities page** in-app and in [Capabilities](capabilities.md). Tool calls can require approval (Settings → Agent Behavior → *Ask before act*) or auto-run (*YOLO*).

## Memory

Agents remember across runs: `memory_save(key, content)` persists facts in SQLite, `memory_recall(query?)` retrieves them at the start of later runs. Memory is per-agent; chat has its own shared scope via `/remember` and `/recall`.
