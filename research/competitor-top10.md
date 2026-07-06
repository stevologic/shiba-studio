# Competitor Top 10 — GrokDesk Inspiration

Sources: **Codex Desktop**, **Claude Cowork**, **Hermes Desktop** (June 2026).

## All 10 implemented

| # | Feature | Source | Implementation |
|---|---------|--------|----------------|
| 1 | Command palette (⌘K / Ctrl+K) | Hermes, Codex | `components/command-palette.tsx` |
| 2 | Diff review after agent edits | Codex | `lib/workspace-diff.ts`, `/api/workspace/diff`, `workspace-diff-panel.tsx` |
| 3 | Live agent run streaming (SSE trace) | Hermes, Codex | `runAgentStream()`, `/api/execute/stream` |
| 4 | Worktree management UI | Codex | `listWorktrees()` / `removeWorktree()`, `/api/workspace/worktrees`, `worktree-panel.tsx` |
| 5 | Plugin / skills browser | Cowork, Codex | `lib/skills-catalog.ts`, `skills-browser.tsx` (agent modal + agents tab) |
| 6 | Session search & archive | Hermes | `searchChatSessions()`, `archiveChatSession()`, chat-sessions-panel search UI |
| 7 | Tool approval mode (ask before act) | Cowork, Hermes | `lib/tool-approval.ts`, Settings YOLO/Ask toggle, `tool-approval-modal.tsx`, `/api/execute/approve` |
| 8 | Preview rail for tool outputs | Hermes | `components/preview-rail.tsx` on Agents tab |
| 9 | Global instructions / AGENTS.md context | Cowork, Codex | `lib/global-instructions.ts`, Settings + injected in agent-runtime + grok stream |
| 10 | Projects multitask sidebar | Codex, Cowork | `components/multitask-sidebar.tsx` in main sidebar |

## GrokDesk strengths (already shipped)

Multi-agent builder, Grok tool loop, worktrees (backend), cron/schedules, MCP, integrations, chat SSE, OAuth, skills as capability tags.