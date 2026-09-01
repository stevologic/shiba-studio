# Grok Bot connector

[Grok Bot](https://x.ai/news/grok-bot-and-x) is xAI’s desktop agent (also included with SuperGrok / Cursor plans). It attaches **remote MCP** servers: a URL plus an optional `Authorization` header. grok.com custom connectors and Grok Build (`grok mcp add --transport http`) use the same wire format.

Shiba Studio exposes a **Streamable HTTP MCP** endpoint so that Bot can operate *this* studio — Board, agents, durable tasks, and the attention inbox — without duplicating Grok Bot’s own X search or coding tools.

## What shipped (and what did not)

Useful, so it is in the product:

- A dedicated bearer (`shiba_grokbot_…`), shown once, stored only as a hash.
- Tools that call the real Board / agent / task-ledger stores.
- Copy-paste plugin JSON, loopback URL, and `grok mcp add` for the desktop Bot and Grok CLI.
- A public URL when `SHIBA_PUBLIC_ORIGIN` is https, for grok.com / xAI Remote MCP.

Not useful (skipped):

- An X @mention listener — Grok Bot already has a native X connector.
- Auto-tunneling localhost to the public internet.
- Shell, git push, or mail send from this connector — those stay behind Studio’s Ask-before-act UI.
- Approving Studio tools from Grok Bot — `list_attention` only reports that the operator must click Approve here.

## Setup

1. Settings → **Grok Bot** → Generate token. Copy the bearer now.
2. **Grok Bot on this machine:** Settings → Plugins → custom MCP. Paste the **loopback** MCP URL (`http://127.0.0.1:3000/api/grok-bot/mcp`) and header `Authorization: Bearer shiba_grokbot_…`.
3. **Grok Build CLI:** copy the `grok mcp add --transport http …` command from the same card.
4. **grok.com / xAI API:** set `SHIBA_PUBLIC_ORIGIN` to an https origin that reaches this process, then paste the public MCP URL as a custom connector / `{ "type": "mcp", "server_url": "…", "server_label": "shiba-studio", "authorization": "Bearer …" }` tool.

The connector is off until you generate a token. Administration is localhost-only. LAN remotes cannot hit `/api/grok-bot/admin`.

## Tools

| Tool | Effect |
| --- | --- |
| `studio_status` | Open Board cards, open durable tasks, agent count |
| `list_agents` | Id, name, model (no credentials) |
| `list_board` | Board cards, optional status/text filter |
| `create_board_card` | New backlog card via `createBoardTask` |
| `list_tasks` | Open ledger tasks |
| `get_task` | One task’s status, progress, attention, children |
| `start_work` | `createTask` + `dispatchExistingTask` |
| `list_attention` | Open approval rows the operator must confirm in Studio |

Calls are logged into a **Grok Bot** chat session so you can see what the Bot asked Studio to do.
