# Capabilities

The Capabilities page is everything your agents can reach: core integrations, skills, MCP servers, and the built-in tool catalog. The in-app catalog is sourced live from the runtime — what you see is exactly what agents can call.

## Core integrations

Provide credentials once; agents with the matching scope can call the service during runs, and scoped context is injected into their prompts.

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

Every credential is AES-256-GCM encrypted at rest. *Test Connection* verifies each one; *Remove* deletes stored credentials.

### Google Drive folder isolation (per agent)

When an agent has the Google Drive scope, its editor shows a **Drive folder scope** picker. Click **Load folders** to list your Drive's folders and select which ones the agent may use. With folders selected, that agent's `drive_list` only returns files inside them and `drive_upload` writes into the first — the model is also told its boundary in-context. Leave it empty for full Drive access. This is *workspace isolation* enforced in the tool layer (so one agent doesn't rummage through your whole Drive), not a hard API-level permission — the underlying token still has full scope.

## Skills

Reusable prompt capabilities you assign to agents — presets plus your own custom skills (create, edit, and manage agent assignments right from the page). An agent's skills are injected into its system prompt on every run.

## MCP servers

One-click presets or any custom stdio MCP server (command, args, env). Enabled servers give agents `mcp_list_tools` and `mcp_invoke` to discover and call their tools.

## Built-in tool catalog

Filterable, grouped, and annotated with what unlocks each tool (local agents only / integration scope / always on):

| Group | Tools |
| --- | --- |
| **Workspace & Files** | `fs_list`, `fs_read`, `fs_write`, `fs_search` (workspace-wide grep), `shell_exec` |
| **Web & Research** | `web_search` (keyless DuckDuckGo), `web_fetch` (page → clean text) |
| **Browser Automation** | `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_extract` |
| **Memory** | `memory_save`, `memory_recall` — facts persist across runs per agent |
| **AI Generation** | `generate_image` — xAI image generation; saves to the workspace and shows in the trace |
| **Integrations** | the per-service tools above, gated by scope |
| **Orchestration** | `schedule_task`, `send_to_peer`, `grok_cli` (headless Grok CLI delegation with effort levels, self-verification `check`, best-of-N, and JSON-schema structured output) |
| **MCP** | `mcp_list_tools`, `mcp_invoke` |

Local-only tools are never offered to cloud agents.
