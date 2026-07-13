# Memories & automatic learning

Memories turn completed work into durable local knowledge. Shiba Studio stores them in SQLite, scopes them to shared Grok Chat or one agent, ranks relevant items against each new task, and injects only a compact set as inert reference context.

## The Memories page

Open **Memories** in the sidebar or type `/memories` in Grok Chat. The page provides:

- key/content search and filters for scope, state, and source;
- separate shared-chat and per-agent scopes;
- a review queue for automatically learned suggestions;
- approve, edit, rescope, pin, archive/restore, and permanent delete actions;
- provenance links back to the run that produced a learned item;
- confidence, recall count, source, and last-updated metadata.

Pinned memories are always considered for recall. Archived and pending memories are never injected into runs. Manual and pinned memories are protected from automatic overwrite, and the learned-memory retention cap never prunes manual items.

## Learning modes

Configure each agent under **Agents → Edit → Learning & memory**:

| Mode | Behavior |
| --- | --- |
| **Off** | No post-run extraction. Relevant existing memories can still be recalled automatically. |
| **Review** | A successful run may propose up to three durable candidates. They remain pending until approved on the Memories page. |
| **Automatic** | Safe, high-confidence candidates are activated immediately. |

Learning adds one small, metered model call after a successful run and remains inside the run's concurrency and token guards. Extraction sees only the task, final outcome, and confirmed side-effect summaries—not raw tool logs or injected integration/project context. Credential-like content, transient status, guesses, and low-confidence candidates are rejected.

## Chat commands

- `/remember <key> | <content>` saves a manual, active memory.
- `/recall [keyword]` lists matching active memories.
- `/forget <key>` deletes one exact key.
- `/memories` opens the management page.

When chatting as a specific agent, these commands use that agent's memory. Plain Grok and **All agents** use the shared-chat scope.

Credential-like notes remain visible locally on the Memories page, but automatic recall and model-visible `/recall` results redact their keys and values so they cannot leak into a later model prompt.

## Agent tools

Autonomous agents can call `memory_save`, `memory_recall`, and `memory_forget`. Automatic relevance recall happens before the model starts working, so agents do not depend on choosing `memory_recall` themselves.

Memories are part of `shiba-studio.db` and are included in normal Studio backups.
