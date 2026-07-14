# Board

<img src="images/board.png" alt="Board: Linear-style Kanban full of agent work — labeled research cards in Backlog and Todo, a card in review with View work / Validate / Refine, and a Done column of delivered assessments" width="880" />

A shared Kanban board — Linear-style — that you and every agent work from. Cards move through **Backlog → Todo → In Progress → In Review → Done** (plus Cancelled), and any card can be assigned to an agent and executed as a real, traced agent run.

## The board

- **Columns** show status with Linear-style glyphs (dashed backlog, progress pie, review dot, done check). Drag cards between columns or reorder within one — position persists.
- **Cards** carry a stable key (`SHIB-12`), priority (urgent / high / medium / low with Linear-style icons), labels, and the assigned agent's avatar. A pulsing **working** badge shows while an agent run is executing the card.
- **New card** (top right) or the **+** on any column header opens an inline composer — type a title, press Enter. Press Enter repeatedly to file several cards fast.
- Click a card for the **detail panel**: title, description, status, priority, assignee, labels, and the full activity feed.

## Sync with Linear or Jira

Connect either service on **Capabilities**, then open **Board → Sync**:

- **Linear:** paste a personal API key, run *Test Connection*, and choose an accessible team.
- **Jira Cloud:** enter the site URL, Atlassian account email, and API token. Scoped API tokens also need the site Cloud ID. *Test Connection* loads visible projects and Jira Software Kanban boards; an optional issue type controls new issues (default: `Task`), and optional JQL narrows what is pulled.

The Sync dialog lets you change the target for that run and choose a direction:

| Direction | Behavior |
| --- | --- |
| **Pull to Shiba** | Import unlinked remote issues and update already-linked Shiba cards. |
| **Push out** | Create remote issues for unlinked Shiba cards and update already-linked issues. |
| **Two-way** | Do both; stored fingerprints reveal which linked copy changed before either side is updated. |

Choose **Task fields only** to sync title, description, priority, and labels while leaving each system's workflow status alone. Choose **Tasks + columns** to sync those fields plus a mapped status: Shiba's six columns map to the closest Linear workflow state or an available Jira transition. It does not recreate an arbitrary remote board layout.

For two-way sync, conflicts happen only when the same linked field changed on both copies since their last successful sync; changes to different fields are merged. The default keeps the value from the copy with the newest task-field change for conflicting fields; you can instead keep Shiba's value or the remote value. After the provider returns an issue ID, stored external references and fingerprints make later syncs reuse that issue.

Every synced card keeps its stable `SHIB-#` key. A Linear or Jira badge shows the remote issue key, and the card detail panel links directly to that issue. One card can carry links to both services.

Sync is intentionally bounded: it never deletes local cards or remote issues, and it does not copy card ordering, Shiba agent assignments, remote assignees, activity/run history, or Jira sprint membership. Provider and workflow-transition failures are reported per item without deleting either copy. If a provider creates an issue but Shiba cannot receive or persist its ID, check that service before retrying because the local card cannot yet know which remote issue to reuse.

Pagination is explicit rather than silent: one run processes up to 10,000 issues. Larger Jira targets return an error so you can narrow the optional JQL; larger Linear teams return an error instead of pretending the partial pull was complete.

## Agents work the board

Two directions, both live:

**You assign work.** Pick an agent in the card's Assignee selector. By default, click **▶ Start work** when the card is ready. You can instead enable **Auto-start future Board assignments** in that agent's setup; every card assigned after the toggle is enabled is accepted immediately, moves to In Progress, and waits safely for an execution slot. Existing assignments are never started retroactively.

The accepted card is a durable task before execution begins, so reloads, temporary capacity limits, and server restarts do not duplicate or silently drop it. One agent accepts one Board card at a time; later assignments wait their turn. Reassignment is fenced while work is active, and cancelling the card prevents a late result from overwriting it.

The agent receives the card (title, brief, labels, and linked project context) as a complete prompt plus board tools, runs as a normal agent run (visible on [Automations](automations.md) with a full execution trace, bounded by the run guards), and posts progress notes into the card's activity feed as it goes. Successful work lands in **In Review** with the outcome summarized. Failures stay in In Progress with the error noted.

**You review the work.** In Review is your gate — nothing reaches Done without you. Every In Review card shows two actions (on the card and in its detail panel):

- **✓ Validate** — approve the work; the card moves to Done with a "Validated" note in the feed.
- **↺ Refine** — describe what needs to change and send it back. The assigned agent reruns with the original brief, its previous outcome, *and your feedback*, told to address it specifically while keeping what was right. The card returns to In Progress while it works and comes back to In Review with the changes summarized. Loop as many times as it takes.

**You collect the deliverables.** Done cards (and the review panel) carry **📦 View work** — a modal with the agent's answer rendered as formatted markdown (links in the output are clickable) and a **Files created** list assembled from the runs' actual trace: every file the agent wrote or image it generated, with its size and a hyperlink that opens it right from the board (code and text render as plain text, images and PDFs inline; a copy button gives you the full path on disk). Files are served only through the owning card — arbitrary paths are rejected.

The header shows how much work is still ahead of review — the **open** count (Backlog + Todo + In Progress combined) — and the same number badges the Board entry in the left nav.

**Agents use the board themselves.** Every agent — scheduled, chat-dispatched, or run manually — has board tools:

| Tool | What it does |
| --- | --- |
| `board_list_tasks` | See the board (filter `mine=true` for its own assignments, or by status) |
| `board_get_task` | Read one card in full, including the activity feed |
| `board_update_task` | Post a progress note and/or move the card's status |
| `board_create_task` | File follow-up work it discovered (lands in Backlog) |

So a nightly agent can check its column, work what's assigned, post progress, and file new cards for things it found — a real team board, not a mirror of one.

## Writing cards agents can execute

The description is the agent's brief — it works from exactly that text. Include the goal, constraints, and what "done" looks like. The agent can't ask follow-up questions mid-run; a card titled "fix the bug" with no description will get you an agent's best guess.

## Where things are stored

The local board, external issue links, and last-sync summaries live in `board.json` under the studio data directory and are included in [backups](configuration.md). Credentials (encrypted at rest) and selected target settings live in configuration. Board actions and syncs are covered by the audit log (`board card created`, `board card dispatched`, `linear board sync completed`, …). Card keys are never reused; deleting local data does not delete issues already created in Linear or Jira.
