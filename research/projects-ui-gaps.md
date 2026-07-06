# Projects UI — Gap Audit (GrokDesk)

## In place (before this goal)

- **Projects tab** with create/delete, file uploads, drag-drop, per-project chat via `GrokChatPanel`
- **Chat context** via `/api/projects/context` — project name, description, uploaded file excerpts (`buildProjectChatContext`)
- **Chat sessions** can link to a `projectId` for shared context
- **Agents tab** (separate) — autonomous runs with SSE trace, diff review, worktrees, tool approval
- **Workspace tab** — global uploads + file tree (not bound to a project)
- **Multitask sidebar** — quick links to projects, chats, automations

## Gaps (blocking “easily build fully featured projects” from UI)

| Gap | Impact |
|-----|--------|
| No per-project **instructions** persisted in UI | Users cannot define how the project should be built without editing JSON |
| No per-project **workspace folder** | Agent runs use agent-level paths; project chat has no disk target for code |
| No **default agent** on project | Must re-pick agent and reconfigure workspace for every build |
| No **Build with agent** from Projects | Must leave Projects → Agents → manually align workspace + prompt |
| Chat and agent runs use **different context** | Instructions/workspace not shared between chat and autonomous builds |

## Implemented (this goal)

1. Extended `Project` model: `instructions`, `workspacePath`, `defaultAgentId` (backward-compatible normalize on load)
2. Projects setup card: instructions textarea, workspace browse, default agent select, save via `POST /api/projects` update
3. **Build with agent** on Projects tab — SSE execute with project workspace override + shared `buildProjectContext`
4. Shared context injected into `/api/projects/context` and `runAgentStream` via `projectContext` + `workspacePathOverride`
5. Live trace, preview rail, and diff review on Projects tab during builds (same components as Agents tab)

## Deferred

- Project scaffold templates (`create-next-app` wizard)
- In-browser Monaco editor / file tree inside Projects
- Cloud deploy / CI/CD from Projects
- Merging agents and projects into one data model
- Mobile shell