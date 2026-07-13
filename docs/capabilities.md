# Capabilities

The Capabilities page is everything agents and the shared Board can reach: core integrations, skills, MCP servers, and the built-in tool catalog. Agent-scoped services become run/chat tools; Linear and Jira are Board-scoped sync targets that every agent reaches through the normal Board tools.

<img src="images/capabilities.png" alt="Capabilities: core integrations including Linear and Jira Board sync, skills, MCP servers, and the tool catalog" width="880" />

## Core integrations

Provide credentials once. Most integrations become tools and context for agents with the matching scope; Linear and Jira instead connect directly to the shared Board.

| Integration | Setup | Unlocks |
| --- | --- | --- |
| **GitHub** | Personal access token | `github_create_issue`, `github_list_repos`, `github_create_pr` (+ `/git pr` in chat) |
| **Slack** | Bot token + default channel; optional App-Level Token (xapp-…) + Socket Mode to **listen for @mentions** | `slack_post`; when listen is on, @mentions run a studio agent and reply in-thread |
| **Google Drive** | Sign in with Google (popup OAuth). One-time setup: create an OAuth client (Desktop app, or Web application with the redirect URI the card shows — `http://localhost:3000/api/google-oauth/callback`), enable the Drive API, paste the client ID+secret. Tokens are captured and refreshed automatically. Service-account JSON is an advanced fallback | `drive_list`, `drive_upload` |
| **Discord** | Bot token + channel id; optional **listen for @mentions** (Gateway + Message Content intent) | `discord_post`; when listen is on, @mentions run a studio agent and reply |
| **X** | API key/secret + access token/secret | `x_post` |
| **Obsidian** | Local vault path, or Local REST API URL + key | `obsidian_list/read/write/search` (+ `/note` in chat) — scoped agents get the vault's contents as live context |
| **Vercel** | Access token from [vercel.com/account/tokens](https://vercel.com/account/tokens); optional team id/slug and default project | `vercel_list_projects`, `vercel_list_deployments`, `vercel_get_deployment`, `vercel_deploy`, `vercel_set_env` — deploy/redeploy git-linked projects, check status, manage env vars |
| **Netlify** | Personal access token from [app.netlify.com/user/applications](https://app.netlify.com/user/applications#personal-access-tokens); optional account slug and default site | `netlify_list_sites`, `netlify_list_deploys`, `netlify_get_deploy`, `netlify_deploy`, `netlify_set_env` — trigger builds for git-linked sites, check deploy status, manage env vars |
| **Linear** | [Personal API key](https://linear.app/settings/api) from Linear's Security & access settings; *Test Connection* loads accessible teams | **Board → Sync**: pull a team's issues, push Shiba cards, or mirror both ways |
| **Jira Cloud** | Site URL + Atlassian email + [API token](https://id.atlassian.com/manage-profile/security/api-tokens); scoped tokens also need the Cloud ID. *Test Connection* loads projects and Jira Software Kanban boards; issue type and extra JQL are optional | **Board → Sync**: pull/push/two-way sync against a project or Kanban board |

Every credential managed by Shiba is AES-256-GCM encrypted at rest. *Test Connection* verifies each one; *Remove* deletes stored credentials. External CLIs can maintain separate caches; the X MCP exception is described below.

### Linear and Jira Board sync

Open **Board → Sync** after connecting. Choose a Linear team, Jira project, or Jira Kanban board; then choose **Pull**, **Push**, or **Two-way**. **Task fields only** mirrors title, description, priority, and labels. **Tasks + columns** also maps Shiba status to the closest Linear workflow state or an allowed Jira transition.

When the same linked field changed on both copies, two-way sync can use the newest task-field change, always keep Shiba, or always keep the remote copy; changes to different fields merge automatically. Successfully linked issues are reused on later syncs, and cards retain their `SHIB-#` keys alongside clickable external issue keys. Sync never deletes either side and does not copy ordering, Shiba agent assignments, remote assignees, activity/run history, or Jira sprints. See [Board](board.md) for the complete behavior and safety boundaries.

### Google Drive folder isolation (per agent)

When an agent has the Google Drive scope, its editor shows a **Drive folder scope** picker. Click **Load folders** to list your Drive's folders and select which ones the agent may use. With folders selected, that agent's `drive_list` only returns files inside them and `drive_upload` writes into the first — the model is also told its boundary in-context. Leave it empty for full Drive access. This is *workspace isolation* enforced in the tool layer (so one agent doesn't rummage through your whole Drive), not a hard API-level permission — the underlying token still has full scope.

## Skills

Reusable prompt capabilities you assign to agents — presets plus your own custom skills (create, edit, and manage agent assignments right from the page). An agent's skills are injected into its system prompt on every run.

Versioned workflow bundles are available through [Capability Packs and the governed Skill Workshop](capability-packs.md). Pack updates cannot broaden permissions without a new explicit review.

## MCP servers

One-click presets or any custom stdio MCP server (command, args, env). Enabled servers give agents `mcp_list_tools` and `mcp_invoke` to discover and call their tools. The X preset uses the official `xurl` bridge: register `http://localhost:8080/callback`, save the X app's OAuth 2.0 Client ID/Secret in the X integration, then click **Add & sign in with X**. On a desktop source install, the first connection opens browser consent; later connections reuse and refresh the isolated cached login automatically. The slim Docker image requires pre-authentication because it has no browser.

## Built-in tool catalog

Filterable, grouped, and annotated with what unlocks each tool (local agents only / integration scope / always on):

| Group | Tools |
| --- | --- |
| **Workspace & Files** | `fs_list`, `fs_read`, `fs_write`, `fs_search` (workspace-wide grep), `shell_exec` (one-shot), `terminal_exec` (runs in the shared Studio Terminal you can watch) |
| **Sandbox** | `sandbox_exec`, `sandbox_write_file` — every agent owns a private **Alpine Linux container** (`shiba-sandbox-<agentId>`, created lazily via Docker) with root, network, and `apk` package installs. State persists in `/work` across runs; fully isolated from the host with memory/CPU/pid limits (memory and CPUs adjustable in Settings → Cost & safety guardrails; running containers pick the change up on next use), and removed when the agent is deleted. Needs Docker running; tools explain that if it isn't |
| **Web & Research** | `web_search` (keyless DuckDuckGo), `web_fetch` (page → clean text) |
| **Browser Automation** | `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_extract` |
| **Memory** | `memory_save`, `memory_recall`, `memory_forget` — scoped facts persist across runs; relevant memories are recalled automatically and optional post-run learning feeds the Memories review queue |
| **AI Generation** | `generate_image` — xAI image generation; saves to the workspace and shows in the trace |
| **Integrations** | the agent-scoped service tools above; Linear and Jira sync through Board rather than direct agent tools |
| **Orchestration** | `schedule_task`, `send_to_peer`, `grok_cli` (headless Grok CLI delegation with effort levels, self-verification `check`, best-of-N, and JSON-schema structured output) |
| **MCP** | `mcp_list_tools`, `mcp_invoke` |

# Native companion nodes

Optional signed native nodes add one-shot Windows inventory, active-window capture and accessibility text, notification, clipboard, file-open, click/type, and quick-entry capabilities. They are a final escalation after connector/MCP and browser surfaces, require live approval plus expiring exact app grants, and block sensitive applications. See [Native companion nodes](./native-nodes.md).
