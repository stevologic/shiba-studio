# Agents

Agents are autonomous Grok workers with their own model, workspace, and capabilities. The **Agents page** is where you view, create, and edit these execution owners. All recurring, one-time, monitored, and event-triggered work is configured and run from **[Automations](automations.md)**.

<img src="images/agents.png" alt="Agents page: local and cloud Grok execution owners with models, workspaces, integration scopes, and skills" width="880" />

Every local agent runs on this machine with files and shell in its workspace, browser automation (Chrome), its own Alpine Linux sandbox container, Grok CLI delegation, MCP tools, cloud integrations (GitHub, Slack, …), web research, and memory. An Automation may assign an agent to execute its instructions, but the trigger and execution policy belong to the Automation.

## Anatomy of an agent

- **Model** — any Cloud (xAI) or Local model; a provider badge shows which.
- **Workspace** — the directory the agent works in. Enable **worktree** to give every run an isolated git worktree of the repo instead of the live checkout.
- **Integration scopes** — per-agent switches for GitHub, Slack, Google Drive, Discord, X, Reddit Devvit, Obsidian, Vercel, and Netlify. A scope both unlocks the matching tools *and* injects live context (an Obsidian-scoped agent gets its vault's contents in every run and chat; Vercel/Netlify-scoped agents see projects/sites and can deploy).
- **Skills** — reusable prompt capabilities from the Capabilities page, plus a free-form *chat Skill* that defines the agent's voice when you chat as it.
- **Peers** — other agents it may message via `send_to_peer`; inboxes drain at the start of the next run.
- **Automation ownership** — Automations select an agent to execute their steps; agents themselves do not store or manage triggers.

Shiba tracks each worktree as an app-owned resource. A configured agent, a direct or project-backed chat, or an active task keeps it alive. After the final agent/chat mapping is removed and active work finishes, cleanup is automatic on the mutation, startup recovery, and periodic integrity passes. Cleanup is two-phase and removes only registered, clean worktrees whose commits are present on a remote; dirty, unpushed, unregistered, or path-identity-unsafe directories are preserved.

## The agent card

Each card shows model, scopes, skills, and workspace, plus:

- **Edit** — the full configuration modal.
- **Terminal icon** — jump to Automations (runs, traces, run-now).
- **History icon** — every past run with status, timestamps, step counts, and *answer* quick-views; click a run for its full execution trace.
- **Delete** — removes the execution owner; its Automations retire safely and historical runs show a 🛸 avatar.

## Tools

Agents act through a tool-calling loop (up to 18 steps per run). The full catalog — workspace files & shell, browser automation, web research, persistent memory, image generation, integrations, orchestration, MCP — is documented on the **Capabilities page** in-app and in [Capabilities](capabilities.md). Tool approval defaults to **Ask before act** (each sensitive tool call is confirmed); *YOLO* auto-run is an explicit opt-in under Settings → Agent Behavior.

Small local models (llama.cpp/Ollama) that print a tool call as text instead of using the structured field still work — the runtime recovers the inline call and executes it. Cloud runs and chats are also bounded by the **Cost & safety** limits (concurrent-run cap, monthly/daily spend hard stop, per-run token cap), and overlapping Automation invocations are skipped — see [Configuration](configuration.md).

## Memory

Agents remember across runs in local SQLite. Relevant active and pinned memories are ranked against the current task and injected at the start as inert reference context, so an agent benefits from prior knowledge without first deciding to call a tool. Agents can also use `memory_save(key, content)`, `memory_recall(query?)`, and `memory_forget(key)` explicitly.

Each agent has a **Learning & memory** policy:

- **Off** — no post-run extraction; automatic recall can remain enabled.
- **Review** — after a successful run, up to three durable candidates enter the Memories review queue.
- **Automatic** — safe candidates become active immediately.

Automatic learning looks only at the user task, final outcome, and confirmed side-effect summaries. It rejects credential-like content, low-confidence candidates, and attempts to overwrite manual or pinned memories. Configure the policy and retention cap in the agent editor, then inspect everything on the [Memories](memories.md) page.
