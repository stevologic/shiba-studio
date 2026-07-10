# Board

<img src="images/board.png" alt="Board: Linear-style Kanban columns with an open card panel showing an agent's activity feed and run trace link" width="880" />

A shared Kanban board — Linear-style — that you and every agent work from. Cards move through **Backlog → Todo → In Progress → In Review → Done** (plus Cancelled), and any card can be assigned to an agent and executed as a real, traced agent run.

## The board

- **Columns** show status with Linear-style glyphs (dashed backlog, progress pie, review dot, done check). Drag cards between columns or reorder within one — position persists.
- **Cards** carry a stable key (`SHIB-12`), priority (urgent / high / medium / low with Linear-style icons), labels, and the assigned agent's avatar. A pulsing **working** badge shows while an agent run is executing the card.
- **New card** (top right) or the **+** on any column header opens an inline composer — type a title, press Enter. Press Enter repeatedly to file several cards fast.
- Click a card for the **detail panel**: title, description, status, priority, assignee, labels, and the full activity feed.

## Agents work the board

Two directions, both live:

**You assign work.** Pick an agent in the card's Assignee selector and hit **▶ Start work**. The agent receives the card (title, brief, labels) as a complete prompt plus board tools, runs as a normal agent run (visible on [Automations](automations.md) with a full execution trace, bounded by the run guards), posts progress notes into the card's activity feed as it goes, and the card lands in **In Review** with the outcome summarized when the run finishes. Failures stay in In Progress with the error noted.

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

The board lives in `board.json` under the studio data directory — local only, included in [backups](configuration.md), covered by the audit log (`board card created`, `board card dispatched`, …). Card keys are never reused.
