# Grok CLI

Shiba Studio integrates the **Grok Build CLI** (`grok`) as a first-class model
source and as an agent tool. When the CLI is installed, you can route chat
through it, give agents a `grok_cli` delegation tool, and use its agentic
features (effort levels, self-verification, best-of-N, structured output) —
all without leaving the studio.

Grok CLI is one of the four ways Shiba Studio reaches Grok, alongside the xAI
API key, OAuth 2.0 with X, and a local OpenAI-compatible server.

## Install & detection

1. Install the `grok` CLI and make sure it's on your `PATH`
   (`grok --version` should work in a terminal).
2. Shiba Studio detects it automatically — `where grok` / `which grok` plus
   `grok --version`. Detection is cached ~30 s.
3. **Settings → Grok Build CLI** shows the detected version and path, lists the
   CLI's own models, and has a **Check for updates** button (`grok update
   --check`). A `GROK CLI` readiness badge appears in the top bar and the
   providers rail when it's found.

If it isn't detected, the card explains that `grok` wasn't found on `PATH`.
No configuration is required beyond having the binary installed.

## Routing chat through the CLI

In any chat, the composer has a **terminal toggle** ("Route through the local
Grok CLI instead of the cloud API"). With it on:

- The conversation is sent to the CLI in headless mode instead of `api.x.ai`.
- A **CLI model picker** appears, limited to the models the CLI itself offers.
- Responses stream back into the chat like any other turn (`/api/grok-cli/stream`).
- The setting is per-session and persists with the chat.

This is useful when you want the CLI's own toolbelt (it has web search and
other built-in tools) or its local execution characteristics.

## The `grok_cli` agent tool

Local agents automatically gain a `grok_cli` tool when the CLI is installed.
It lets an agent **delegate a whole coding/exploration task** to Grok CLI in
headless mode and get the result back into its run. Parameters:

| Argument | Type | Meaning |
| --- | --- | --- |
| `prompt` | string (required) | Instructions for the CLI. |
| `max_turns` | number | Max agent turns (default 12). |
| `effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | Agentic effort level (`--effort`). |
| `check` | boolean | Append a self-verification loop so the CLI double-checks its own work (`--check`). |
| `best_of_n` | number (2–4) | Run the task N ways in parallel and keep the best result (`--best-of-n`). |
| `json_schema` | string | A JSON Schema that constrains the CLI's output to structured JSON (`--json-schema`). |

The system prompt tells the agent the CLI is available and how to use it. The
tool call, its arguments, and the CLI's output all appear in the run's
execution trace like any other tool.

Under the hood (`lib/grok-cli.ts`) the CLI is spawned with `shell: false` (no
shell injection), a 5-minute default timeout, the agent's workspace as the cwd,
and abort-signal support so a cancelled run stops the CLI too. Prompts assembled
from a conversation are sanitized and length-bounded to stay within Windows
spawn limits.

## Output formats

The runner supports `plain`, `json`, and `streaming-json` output. Structured
modes back the `json_schema` option so an agent can get machine-readable results
it can act on, rather than free text.

## Updating the CLI

Use **Settings → Grok Build CLI → Check for updates** (runs `grok update
--check`). If a newer version exists, the card shows it; run `grok update` in a
terminal to install it. The status badge and version refresh on the next detect.

## Troubleshooting

- **No `GROK CLI` badge / "grok not found on PATH":** the binary isn't on
  `PATH` for the process running Shiba Studio. Reinstall or fix `PATH`, then
  reload Settings (detection re-runs).
- **The tool isn't offered to an agent:** only **local** agents get `grok_cli`
  (cloud agents have no local machine access), and only when the CLI is
  detected at run start.
- **A run hangs on a CLI step:** the CLI has a 5-minute default timeout;
  cancelling the run aborts the CLI process.

See also: [Chat](chat.md) for the composer toggle, [Agents](agents.md) for the
tool catalog, and [Configuration](configuration.md) for the Settings card.
