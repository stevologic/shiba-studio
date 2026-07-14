# Product ideas for Shiba Studio

> Research snapshot: July 12, 2026. This is a product-planning document, not a
> commitment to ship every item. Competitor capabilities and rollout status can
> change quickly, so the linked primary sources should be checked again before
> implementation.

## Executive recommendation

Shiba Studio is not missing the basic pieces of an agent product. It already has
workspace-aware chat, local and cloud agents, background work, durable Automations,
worktrees, browser automation, a shared Board, voice, reviewed memory learning,
MCP, custom skills, integrations, approvals, sandboxes, diffs, audit history,
cost controls, and backup/restore.

The largest remaining opportunity is to turn those pieces into a **trustworthy
task operating system**. A user should be able to state an outcome, let Shiba
route and parallelize the work, leave the desk, steer or approve it remotely,
see proof that it is done, and rewind safely if it is not.

The highest-leverage sequence is:

1. Build a durable task ledger and one exact-approval inbox.
2. Add completion contracts, verification evidence, and safe rewind.
3. Fix long-session context scaling and add session forks.
4. Keep expanding the durable Automation engine beyond time-based triggers.
5. Put a secure remote companion on top of that substrate.

Everything else becomes easier and safer once those foundations exist.

## What Shiba already covers

These are strengths to extend, not features to rebuild under a competitor's
name:

| Capability | Current Shiba surface |
| --- | --- |
| Workspace-aware chat and coding | Folder-bound chat, file tools, shell, Git commands, background tasks, and diffs ([Chat](docs/chat.md)) |
| Autonomous agents | Per-agent model, workspace, worktree, integrations, skills, peers, sandbox, and memory ([Agents](docs/agents.md)) |
| Parallel answers | "All agents" parallel fan-out with a synthesized response |
| Browser work | Controlled Chrome plus the annotation sub-browser and screenshot evidence |
| Automation | One durable engine for recurring, one-time, monitored, and event-driven work, with overlap suppression, traces, and run history ([Automations](docs/automations.md)) |
| Shared work queue | Kanban Board with agent execution and Linear/Jira synchronization ([Board](docs/board.md)) |
| Memory and learning | Scoped recall plus reviewed or automatic post-run learning ([Memories](docs/memories.md)) |
| Extensibility | Custom skills, stdio MCP servers, 40+ built-in tools, and service integrations ([Capabilities](docs/capabilities.md)) |
| Safety and operations | Ask-before-act, audit log, encrypted credentials, spend limits, concurrency limits, isolated containers, backup/restore |
| Voice | Dictation, spoken replies, group voice, and acoustic barge-in |

This baseline matters. For example, another generic Kanban, second automation editor, MCP
catalog, browser, or static multi-agent answer mode would add less value than
making the existing versions durable, steerable, and recoverable.

## What the latest products do especially well

The comparison below is deliberately about differentiated product patterns, not
raw tool counts.

| Product | Most relevant current strengths | Lesson for Shiba |
| --- | --- | --- |
| **ChatGPT Desktop** | A unified shell with explicit Chat, Work, and Codex modes; steerable long-running work; projects and goals; artifact previews with focused annotations; remote supervision; plugins; Record & Replay on supported macOS accounts; Codex worktree isolation | Route by task intent, make progress and attention visible, and turn demonstrated workflows into reusable capabilities |
| **OpenClaw** | An always-on self-hosted gateway; mobile/channel clients; durable background-task delivery; cron, heartbeats, hooks, and standing orders; governed skill learning; scoped harness attachment in the July beta; detailed execution approvals; `doctor` diagnostics | Treat tasks, delivery, remote clients, automation, skills, and repair as one coherent control plane |
| **Hermes Agent** | Persistent goals with completion contracts; verification evidence; `/learn` and a learning journey; background subagent fan-out; fast session search; checkpoints with chat rollback; durable multi-agent Kanban; automation blueprints | Make agents prove completion, learn procedures, parallelize visibly, and undo safely |
| **Claude / Cowork / Claude Code** | Remote, steerable sessions; parallel subagents; connector-first/browser-second/screen-last computer use; per-app permissions; plugin bundles; scheduled routines; Office/PDF creation; live, refreshable, versioned artifacts | Prefer precise tools before GUI control, package whole workflows, and make finished deliverables first-class objects |

### Identity and release notes

- The unified **ChatGPT Desktop** app launched globally on macOS and Windows on
  July 9, 2026, combining Chat, Work, and Codex. The prior app can remain as
  ChatGPT Classic, but new agent features may be available only in the new app.
  Work and several computer-use, recording, publishing, and workflow-capture
  features remain plan-, platform-, region-, or rollout-dependent. Current
  Learn documentation describes desktop Scheduled work, while the generic
  Tasks FAQ still describes its Scheduled tab as web/mobile; this document
  therefore treats scheduling as a product pattern, not universal desktop
  availability.
- **OpenClaw** means the personal AI gateway at
  [openclaw/openclaw](https://github.com/openclaw/openclaw), formerly
  Clawdbot/Moltbot—not the Captain Claw game reimplementation or NVIDIA
  NemoClaw. The latest stable reviewed here is
  [v2026.6.11](https://github.com/openclaw/openclaw/releases/tag/v2026.6.11).
  The July 11
  [v2026.7.1-beta.5](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1-beta.5)
  is used only as directional evidence because its own notes disclose incomplete
  validation.
- **Hermes** means [Nous Research's Hermes Agent](https://github.com/NousResearch/hermes-agent),
  not only the Hermes model family. The latest release is the July 7 dependency
  patch [v0.18.2 / v2026.7.7.2](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2);
  the July 1
  [v0.18.0 / v2026.7.1](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.1)
  is the latest fully curated feature baseline used here.

## Prioritized roadmap

### P0 — foundations that multiply the rest of the product

#### 1. Shiba Dispatch: mode-aware routing plus a durable task ledger

**Problem:** Chat, background tasks, agent runs, Automation invocations, Board work, and
integration-triggered work exist, but they do not yet feel like one task system.
The user has to choose the surface and mentally track where results or approval
requests will appear.

**Proposal:** Put one lightweight dispatcher in front of the existing engines:

- **Quick chat** for an immediate answer.
- **Work** for research, analysis, and a finished deliverable.
- **Code** for a workspace/worktree, diffs, tests, and Git output.
- **Routine** for one-time, scheduled, monitored, or event-triggered work.

Every non-trivial request should create the same durable task record with:

- parent task, originating chat/card/Automation invocation, and child worker links;
- `queued`, `running`, `waiting_for_input`, `waiting_for_approval`, `blocked`,
  `succeeded`, `failed`, `cancelled`, and `lost` states;
- current plan, active step, next action, progress, retry count, and heartbeat;
- idempotent completion delivery through a transactional outbox;
- pause, cancel, retry, resume, and append-instruction controls;
- one **Attention inbox** reserved for live, exact approvals; task outcomes stay in task/run history and originating chats.

A project capsule should be able to attach multiple repositories or workspace
roots, each with its own permission boundary and Git state, so cross-repository
initiatives can share one task without silently broadening file access.

The router should recommend a mode but always let the user override it. It
should reuse the current run engine rather than introduce a second agent
runtime.

**Implementation seams:** `lib/background-tasks.ts`,
`lib/agent-runs-store.ts`, `lib/live-events.ts`, `lib/app-events.ts`,
`app/api/runs/route.ts`, the chat background-task tools, and Automations.

**Success criteria:** after a server restart, a detached task retains its durable
record, requester/children, evidence, and delivery state and is deterministically
marked resumable, retryable, or `lost`; checkpointed work may actually resume.
It delivers its terminal result exactly once and can be steered, cancelled, or
retried from the same UI regardless of how it started.

Inspired by [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex),
[Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork),
and [OpenClaw background tasks](https://docs.openclaw.ai/automation/tasks).

#### 2. Completion contracts and a verification evidence ledger

**Problem:** A final answer can say that work is complete without a structured
record of what “done” meant or which evidence proved it.

**Proposal:** Let a user or agent attach a completion contract to any task:

- outcome and non-negotiable constraints;
- required artifacts;
- named checks or automatically detected project checks;
- side effects that must be confirmed;
- evidence freshness and scope requirements.

The runtime should record evidence as typed entries—command plus exit status,
test summary, build URL, screenshot, diff, deployment status, or human approval.
Before marking a task complete, a bounded verifier compares every contract item
with current evidence. “Not proven” remains incomplete instead of becoming a
confident success message.

This should also power Board card proof, scheduled monitoring assertions, and a
compact “Why Shiba thinks this is done” view.

**Implementation seams:** run records and traces, `lib/project-run.ts`, Board
work proof/artifacts, `lib/agent-runtime.ts`, and the existing verification
scripts.

**Success criteria:** each required contract item is independently `proven`,
`failed`, or `missing`; stale or narrower evidence cannot satisfy a broader
claim; the final answer links to the evidence.

Inspired by [Hermes persistent goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals)
and the verification changes in
[Hermes v0.18.0](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.1).

#### 3. Automatic checkpoints and synchronized rewind

**Problem:** Worktrees and diff review reduce collision risk, but there is no
universal “return to how the task and conversation looked before this action”
control.

**Proposal:** Create a checkpoint before the first mutation and at meaningful
approval boundaries. A checkpoint should bind:

- Git/worktree state or a bounded non-Git file snapshot;
- conversation message and tool-call cursor;
- task plan and status;
- browser URL/screenshot where useful;
- active approvals and generated artifacts.

Rewind should restore both files and task/chat state. Offer “fork from here” as
the non-destructive default and “rewind this task” as an explicit destructive
action. The message-level session fork below must use this same immutable branch
primitive, not a second copy model. Never touch unrelated user changes.

**Implementation seams:** `lib/workspace-diff.ts`, `lib/git-actions.ts`,
worktree management, chat sessions, and run traces.

**Success criteria:** a user can undo a failed multi-step edit without manually
reverse-engineering the diff, while unrelated pre-existing changes remain
byte-for-byte intact.

Inspired by [Hermes checkpoints and rollback](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback)
and [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing).

#### 4. A real long-session context engine

**Problem:** Shiba stores full session history but replays only the latest 60
messages to the model, with an omission notice for older turns. That bounds each
request, but there is no semantic compaction or pinned-context layer, so early
constraints eventually fall out of the prompt instead of being summarized.

**Proposal:** Add transparent, inspectable context management:

- a context-window meter with token/model/tool-result breakdown;
- pinned instructions, messages, files, memories, and decisions;
- in-place rolling compaction with links back to source messages;
- tool-result truncation plus durable artifact storage;
- branch/fork from any user or assistant message;
- true per-project session groups and unread state while preserving the current
  archive/restore and Markdown export surfaces;
- an agent-facing `session_search` tool that returns bounded source messages,
  match windows, conversation bookends, and provenance rather than an
  ungrounded summary;
- an **ephemeral session** switch that neither reads nor writes memories and is
  deleted on close.

Compaction must preserve unresolved questions, approvals, constraints, current
plan state, and completion-contract requirements. The user should be able to
inspect or regenerate a summary rather than trusting a hidden lossy process.

**Implementation seams:** `lib/chat-sessions.ts`, chat session types,
`app/api/grok/stream/route.ts`, `components/chat-sessions-panel.tsx`, and usage
metering.

**Success criteria:** 100+ turn sessions remain responsive; pinned constraints
survive compaction; a branch does not mutate its parent; an agent can retrieve
bounded evidence from earlier sessions; context use and summary provenance are
visible.

Inspired by [Hermes sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions),
OpenClaw's session operations in
[v2026.7.1-beta.5](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1-beta.5),
and [Claude incognito chats](https://support.claude.com/en/articles/12260368-use-incognito-chats).

#### 5. Keep Automations event-driven, not cron-only

**Problem:** Exact schedules are useful, but much valuable work begins when
something changes, a promise becomes due, or a health condition fails. Shiba's
`schedule_task` creates a durable Automation for both five-field cron and relative
or date-like one-time requests, so every follow-up survives a restart and remains
visible on the same Automations surface.

**Proposal:** Keep broadening the single Automation strategy with composable triggers:

- durable one-time reminders and natural-language schedules;
- GitHub push, issue, PR, review, and failed-check events;
- Linear/Jira card transitions;
- Slack/Discord mentions using the listeners Shiba already runs;
- generic signed webhooks;
- filesystem changes and local process/URL health checks;
- context-aware heartbeats and change monitors;
- follow-up commitments proposed from chat and activated only after approval.

Add conditions, template parameters, retry/backoff, timeout, concurrency key,
catch-up policy, circuit breaker, and dependent steps. Start with a form plus
JSON/YAML export; a full visual workflow canvas can wait.

**Implementation seams:** `lib/routines.ts`, `lib/automation-cron.ts`,
`lib/channel-listeners.ts`, `lib/board-runner.ts`, integration clients,
`/api/routines`, and the task ledger.

**Success criteria:** the same routine can be run manually, on a schedule, or by
an event; duplicate webhook delivery cannot duplicate side effects; repeated
failure trips a visible circuit breaker and remains in task/run history without adding approval-inbox noise.

Inspired by [OpenClaw's automation model](https://docs.openclaw.ai/cron-vs-heartbeat),
[Hermes automation blueprints](https://hermes-agent.nousresearch.com/docs/reference/automation-blueprints-catalog),
and [Claude Code routines](https://code.claude.com/docs/en/web-scheduled-tasks).

### P1 — major capability multipliers

#### 6. Secure remote companion for tasks and exact approvals

Keep execution and secrets on the Shiba host, but let a paired phone, tablet, or
browser:

- see task state and recent evidence;
- receive exact pending-approval notifications and inspect durable task state;
- approve one exact action, deny it, or grant a bounded rule;
- append steering instructions or cancel a task;
- start a saved routine or a voice request;
- browse a small encrypted offline cache of recent task summaries.

Shiba already exposes its full web app through explicit `dev:lan` / `start:lan`
and `shiba.local`. The gap is a paired, scoped, mobile-focused client with push,
offline summaries, and safe approvals—not generic remote browser access. Start
as an installable PWA over LAN/Tailscale with QR pairing. This is only a remote
view of the P0 approval inbox and task ledger, never a second queue or store.
Use a scoped, revocable device key, short approval TTLs, and an explicit
remote-access toggle. Do not begin with a public relay or a dozen messaging
channels.

**Success criteria:** no workspace file or integration secret is copied to the
companion; every remote action is attributable and revocable; a user can clear
the pending approval queue without opening the main desktop browser.

Inspired by [OpenClaw remote access](https://docs.openclaw.ai/gateway/remote),
[ChatGPT remote connections](https://learn.chatgpt.com/docs/remote-connections),
and [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control).

#### 7. Capability Packs and a governed Skill Workshop

Shiba's skills, MCP servers, integrations, agents, and Automations are currently
configured separately. Add a versioned **Capability Pack** that can bundle:

- skills and slash commands;
- agent/subagent definitions;
- MCP servers and integration requirements;
- event hooks and Routine templates;
- permission requests and supported surfaces;
- setup checks, examples, tests, and migration metadata.

Permissions must be action-level: read/write class, constrained parameters,
resource/account scope, confirmation policy, and supported surfaces. New tools,
actions, or broader parameters introduced by an update default to disabled until
they are reviewed.

Add “Learn this workflow” from a successful run, a URL, or a folder. Learning
creates a proposal—not a live mutation—with a source hash, generated diff,
security scan, declared variables, test case, scope, and rollback version. A
human approves activation. A local directory or Git repository is enough for
the first registry; a public marketplace should follow only after signing,
trust, update, and removal semantics are solid.

Track each learned skill's source, versions, usage, last success, staleness,
pin/archive state, and rollback. Present memories and learned skills together in
a **Learning Journey** so users can see what Shiba learned, why it learned it,
whether it still works, and remove or correct it. A bounded curator may propose
consolidation or retirement, but never mutate active skills without the selected
review policy.

**Implementation seams:** `lib/custom-skills.ts`, `lib/skills-catalog.ts`,
`lib/mcp.ts`, integration catalog, agent definitions, and Automations.

**Success criteria:** a pack is portable, reviewable, versioned, removable, and
cannot silently expand its permissions during an update.

Inspired by [ChatGPT plugins](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex),
[ChatGPT Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay),
[OpenClaw Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop),
[Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/),
the [Hermes Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator),
and [Claude plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude).

#### 8. Dynamic agent teams with a visible task graph

Shiba already has named peer agents and all-agent answer synthesis. Add a
coordinator that can spawn bounded specialists for one task and show their
relationships:

This coordinator and worker tree must be a projection over the P0 task state
machine, not a separate lifecycle or task store.

- dependency graph, claim owner, heartbeat, and attempt count;
- per-worker model, tools, integration scopes, token/time budget, and maximum
  turns;
- isolated worktree for writers and read-only sharing for researchers;
- live worker tree with pause, cancel, steer, and inspect controls;
- structured result and verification evidence returned to the parent;
- automatic reclaim of crashed or abandoned work.

Use this for genuinely separable work, not every prompt. Preserve the simpler
“All agents” mode for fast perspective gathering.

**Implementation seams:** `lib/multi-agent-chat.ts`, `lib/agent-inbox.ts`,
`lib/board-work.ts`, `lib/board-runner.ts`, worktrees, and the task ledger.

**Success criteria:** independent research is measurably faster; simultaneous
writers cannot collide; lost workers are detected; the parent cannot claim
completion without collecting required child evidence.

Inspired by [Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation),
[Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban),
[ChatGPT subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
and [Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

#### 9. Artifact Studio for finished work

Treat generated outputs as first-class objects instead of only files or trace
attachments:

- render and preview HTML, PDF, Word, PowerPoint, and Excel;
- verify the rendered result, not just successful file creation;
- annotate a region, slide, page, table, or cell and send that location back as
  revision context;
- retain versions, source lineage, task evidence, and rollback;
- support interactive HTML dashboards and visualizations;
- optionally refresh a live artifact from explicitly approved read-only
  connectors, with mutations disabled by default.
- move from private preview to an explicit publish/share step for lightweight
  dashboards, reports, and trackers, with audience controls, revocation, and
  takedown.

Shiba's annotation browser and preview rail are strong starting points. Reuse
their focused-feedback model rather than creating a separate chat product.
Artifact versions must reuse checkpoint/version IDs, and render checks must
write into the task's verification evidence ledger rather than introducing new
version or proof stores.

**Implementation seams:** `components/preview-rail.tsx`, file serving,
workspace uploads, browser screenshots, and run artifacts.

**Success criteria:** supported documents are visually checked before delivery;
feedback is anchored to a precise location; versions and data sources are
inspectable; a live refresh cannot silently write to an integration.

Inspired by [ChatGPT's artifact viewer](https://learn.chatgpt.com/docs/artifacts-viewer),
[ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites),
[Claude file creation](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude),
and [Claude live artifacts](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork).

#### 10. Shiba Doctor and crash-safe recovery

Add a read-only diagnostics command/page with machine-readable results, followed
by separately approved repairs. Checks should cover:

- xAI/local model reachability, credentials, quotas, and model discovery;
- X/Google OAuth refresh and callback configuration;
- MCP process startup and tool discovery;
- Chrome/Chromium availability and browser health;
- Automation-engine heartbeat, stuck runs, and lost task detection;
- SQLite integrity, migrations, encryption key, backup freshness, and disk space;
- orphaned worktrees, ports, terminal bridge, firewall/origin, and LAN exposure;
- plugin/pack compatibility and missing dependencies.

After repeated startup failure, offer a safe mode that disables optional
listeners, MCP servers, and packs while preserving data.

**Success criteria:** support reports can be generated without exposing secrets;
read-only diagnosis never mutates state; every repair previews its exact effect
and can be audited.

Inspired by [OpenClaw Doctor](https://docs.openclaw.ai/gateway/doctor) and the
reliability focus of
[OpenClaw v2026.6.11](https://docs.openclaw.ai/releases/2026.6.11).

### P2 — valuable after the control plane is solid

#### 11. Optional native companion nodes for desktop computer use

Do not rewrite Shiba in Electron just to gain screen control. Build a small,
optional signed helper per machine that exposes narrowly scoped capabilities:

- active-window screenshot plus accessibility text;
- app/window inventory, notifications, clipboard, and file-open actions;
- click/type/screenshot for explicitly allowed applications;
- quick-entry global hotkey and drag/drop capture.

Use an escalation ladder: integration/MCP first, controlled browser second,
signed-in user browser only when needed, and broad GUI interaction last. Require
per-app permission, block sensitive app classes by default, expire remembered
grants, visibly indicate capture, and scan untrusted screen/page content for
prompt injection.

Inspired by [ChatGPT computer use](https://learn.chatgpt.com/docs/computer-use),
[ChatGPT Appshots](https://learn.chatgpt.com/docs/appshots), and
[Claude computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork).

#### 12. Scoped handoff to specialized external coding harnesses

Optionally let a Shiba task attach Codex CLI, Claude Code, Hermes Agent, or
another compatible harness without making that provider Shiba's core model.
Issue a single-session, TTL-bound, revocable capability grant containing only
the selected workspace, task context, allowed tools, and callback channel.
Exclude ambient MCP servers and secrets; bind approvals to normalized action,
workspace, account, arguments, and resource revision.

The external worker should appear as a child task and return diffs, evidence,
and status to Shiba. This lets Shiba remain the Grok-first local control plane
while using specialist surfaces when the user explicitly asks.

Inspired by [OpenClaw attach](https://docs.openclaw.ai/cli/attach) and Claude
Code's [desktop environments](https://code.claude.com/docs/en/desktop).

#### 13. Meeting and voice-note capture

Shiba's conversational voice mode is not the same as capturing a long meeting
or voice note. Add an explicit recording surface that can, with informed
consent:

- capture microphone and optional system audio;
- show a live speaker-aware transcript;
- produce a reviewable summary, decisions, owners, and action items;
- create linked Board cards or follow-up Routines only after confirmation;
- store audio locally with clear retention and deletion controls;
- let later chats cite exact transcript timestamps.

Start with user-supplied audio files and microphone capture before attempting
system-audio capture on every platform. Prominently remind the user that they
are responsible for consent and applicable recording laws.

Inspired by [ChatGPT Record](https://help.openai.com/en/articles/11487532-chatgpt-record).

## Recommended delivery order

| Increment | Deliverable | Why this order |
| --- | --- | --- |
| **A** | Universal task state machine, parent/child links, heartbeat, outbox, exact-approval inbox, OS/browser notifications | Makes every existing background feature more reliable immediately |
| **B** | Completion contracts, evidence ledger, pre-mutation checkpoint, fork/rewind | Builds trust before increasing autonomy |
| **C** | Context meter, pinned context, compaction, grounded session search, fork/grouping/ephemeral mode | Removes a concrete latency/cost ceiling and improves long projects while preserving existing archive/export |
| **D** | One-time schedules, signed webhooks, GitHub events, retries, circuit breakers, natural-language Routine creation | Expands useful automation on a durable base |
| **E** | Tailscale/LAN PWA pairing, push notifications, approval and steering controls | Delivers the largest day-to-day convenience without moving secrets to a cloud service |
| **F** | Capability Pack manifest plus learn → proposal → scan/test → approve | Makes extension safe and repeatable before a marketplace exists |
| **G** | Dynamic worker graph and Artifact Studio MVP | Adds power once task ownership, evidence, and recovery are trustworthy |

## Ideas to avoid or defer

- **Do not add a broad model catalog just because OpenClaw or Hermes has one.**
  Grok/xAI plus local OpenAI-compatible models is a coherent Shiba identity.
  Utility work can use a cheaper xAI/local model without turning the product
  into a provider switchboard.
- **Do not implement every messaging channel.** Prove the remote companion and
  attention flow first; Slack/Discord listeners already cover two useful inbound
  surfaces.
- **Do not loosen Ask-before-act.** OpenClaw's host-exec posture is not a model
  for Shiba. Bind approvals more tightly rather than reducing them.
- **Do not build another Board.** Add dependencies, proof, claims, retries,
  heartbeats, and worker recovery beneath Shiba's existing Board.
- **Do not build a marketplace before package trust exists.** Versioning,
  permissions, signatures, scans, migrations, and reliable uninstall come
  first.
- **Do not make continuous screen journaling a default.** If an opt-in work
  journal is ever added, it needs a visible capture state, encryption, short
  retention, and per-app exclusions.
- **Do not copy prerelease features uncritically.** OpenClaw's July beta is
  useful roadmap evidence, not a quality bar.

## Source map

### Shiba Studio baseline

- [README](README.md)
- [Architecture](docs/architecture.md)
- [Chat](docs/chat.md)
- [Agents](docs/agents.md)
- [Automations](docs/automations.md)
- [Capabilities](docs/capabilities.md)
- [Memories](docs/memories.md)
- [Current release TODO and known gaps](TODO.md)

### ChatGPT Desktop

- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Moving to the new desktop app](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app)
- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)
- [Desktop app documentation](https://learn.chatgpt.com/docs/app)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- [Projects](https://learn.chatgpt.com/docs/projects)
- [Automations](https://learn.chatgpt.com/docs/automations)
- [Generic Tasks FAQ](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)
- [Artifact viewer](https://learn.chatgpt.com/docs/artifacts-viewer)
- [ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites)
- [Browser](https://learn.chatgpt.com/docs/browser)
- [Appshots](https://learn.chatgpt.com/docs/appshots)
- [Computer use](https://learn.chatgpt.com/docs/computer-use)
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [ChatGPT Record](https://help.openai.com/en/articles/11487532-chatgpt-record)
- [Plugins](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
- [Apps and connector controls](https://help.openai.com/en/articles/11487775-connector)

### OpenClaw

- [Official documentation](https://docs.openclaw.ai/)
- [Stable v2026.6.11 release](https://docs.openclaw.ai/releases/2026.6.11)
- [Remote gateway topology](https://docs.openclaw.ai/gateway/remote)
- [Background tasks](https://docs.openclaw.ai/automation/tasks)
- [Cron, heartbeat, and automation guidance](https://docs.openclaw.ai/cron-vs-heartbeat)
- [Active Memory](https://docs.openclaw.ai/concepts/active-memory)
- [Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop)
- [Execution approvals](https://docs.openclaw.ai/tools/exec-approvals)
- [Doctor](https://docs.openclaw.ai/gateway/doctor)
- [Attach CLI](https://docs.openclaw.ai/cli/attach)
- [July beta](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1-beta.5)

### Hermes Agent

- [Latest v0.18.2 / v2026.7.7.2 patch](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2)
- [Hermes Agent v0.18.0 / v2026.7.1](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.1)
- [Persistent goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)
- [Subagent delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Checkpoints and rollback](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback)
- [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
- [Automation blueprints](https://hermes-agent.nousresearch.com/docs/reference/automation-blueprints-catalog)

### Claude, Cowork, and Claude Code

- [Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [Computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- [Plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)
- [Connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [File creation](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)
- [Live artifacts](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)
- [Scheduled Cowork tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Code routines](https://code.claude.com/docs/en/web-scheduled-tasks)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)
