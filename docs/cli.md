# Grok Build CLI

Shiba Studio integrates the official, open-source **Grok Build CLI** (`grok`)
from [`xai-org/grok-build`](https://github.com/xai-org/grok-build) as a model
source and as an agent delegation tool. Grok Build is one of the ways Shiba
reaches Grok, alongside an xAI API key, OAuth 2.0 with X, and a local
OpenAI-compatible server.

## Compatibility baseline

The integration is audited against these distinct upstream artifacts:

| Artifact | Audited value |
| --- | --- |
| Public repository snapshot | [`98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`](https://github.com/xai-org/grok-build/commit/98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce) on `main` |
| Upstream monorepo revision recorded by `SOURCE_REV` | `124d85bc5dc6e7805560215fcc6d5413944920e1` |
| Version declared by that source snapshot | `0.2.102` |
| Released binary exercised by Shiba's compatibility checks | `0.2.103` |

The source version and the released binary version are intentionally reported
separately. The public source is a periodically synchronized snapshot, so its
crate version can trail the currently released binary without indicating an
installation error.

Shiba targets the official Grok Build command and protocol contract. Other
projects named “Grok CLI,” including community-maintained packages that also
install a `grok` executable, are separate codebases and are not interchangeable
with this integration.

## Install and authenticate

Use the official released-binary installer for your platform:

```sh
# macOS / Linux / Git Bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```

Then confirm both the executable and the authenticated model catalog:

```sh
grok --version
grok models
```

Shiba locates `grok` on `PATH`, reads its version, and uses `grok models` as
the readiness probe for authentication and model discovery. A binary can
therefore be installed but not yet ready to run; in that case, open a terminal,
finish Grok Build's sign-in flow, and run `grok models` again.

For credential safety, Shiba does not pass an ambient `XAI_API_KEY` to an
arbitrary executable discovered by name on `PATH`. Normal cached `grok login`
credentials still work. In a controlled headless environment that requires
API-key auth, set `SHIBA_GROK_CLI_PATH` to the absolute operator-trusted Grok
Build binary; only that explicitly pinned path may receive `XAI_API_KEY`.
Shiba verifies the file before reporting it installed (Windows paths must name
an existing `.exe`; Unix paths must be executable).

**Settings → Grok Build CLI** shows the detected path and version, readiness,
and the CLI's model list. Detection is cached briefly, and the top bar and
provider rail show the CLI badge when the command is ready.

## The two official embedding modes

Grok Build exposes two different programmatic harnesses. They solve different
problems:

| Harness | Lifecycle | Protocol | Shiba status |
| --- | --- | --- | --- |
| Headless single prompt | One process per request | `grok --no-auto-update -p … --output-format <format>`; chat uses NDJSON, delegation uses plain or schema-constrained output | Used today for CLI-routed chat and the `grok_cli` agent tool |
| IDE agent | Persistent process | `grok agent stdio`; Agent Client Protocol (ACP) JSON-RPC over stdin/stdout | Official IDE/client capability, documented for integrations; not the transport Shiba currently launches |

The persistent ACP harness supports sessions, streamed messages and thoughts,
tool-call visibility, and interactive permission requests. It is the right
upstream contract for an editor client that wants to own a long-lived Grok
session. Shiba's current integration deliberately uses managed, one-shot
headless processes instead, so each request has a bounded process lifetime and
an explicit workspace.

See [Grok Build harnesses](grok-build-harnesses.md) for the lifecycle,
protocol, and external-grant boundaries.

## Routing chat through the CLI

In any chat, the composer has a **terminal toggle** (“Route through the local
Grok CLI instead of the cloud API”). With it on:

- The conversation is sent to a fresh Grok Build headless process instead of
  directly to `api.x.ai`.
- Shiba invokes the managed command with `--no-auto-update`, `-p`, and
  `--output-format streaming-json`.
- A CLI model picker is limited to the models returned by `grok models`.
- Grok Build's newline-delimited `text`, `thought`, `end`, and `error` events
  are converted to Shiba's normal chat stream.
- The routing choice is stored per chat session.

`--no-auto-update` prevents a background binary replacement from racing a
managed request. It does not disable Grok Build's coding tools. Update the CLI
explicitly outside an active run.

## The `grok_cli` agent tool

Local agents gain a `grok_cli` tool when the official CLI is ready. It delegates
a bounded coding or exploration task to the same one-shot headless harness and
returns the result to the parent run.

| Argument | Type | Meaning |
| --- | --- | --- |
| `prompt` | string (required) | Instructions for the CLI. |
| `max_turns` | number | Maximum agentic turns (default 12). |
| `effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | Reasoning effort (`--effort`). |
| `check` | boolean | Append Grok Build's self-verification loop (`--check`). |
| `best_of_n` | number (2–4) | Run the task multiple ways and select the best result (`--best-of-n`). |
| `json_schema` | string | Constrain the final result with a JSON Schema (`--json-schema`). |

The tool call, arguments, and CLI result appear in the run trace. The process
is launched without a shell, receives the selected workspace as its working
directory, has a five-minute default timeout, and is stopped when its parent
run is cancelled. Prompt sizes are bounded for cross-platform process limits.
Because headless Grok cannot show approval prompts, CLI-routed chat and
CLI-model runs opt into `bypassPermissions` only when Shiba's global approval
mode is explicitly set to **YOLO**. In Ask mode, operations that would require
an interactive prompt are denied. A `grok_cli` tool call may run unattended
after the parent agent's normal Shiba approval gate authorizes that delegation.
Upstream deny rules, hooks, and administrative locks continue to apply, and
read-only runs never opt in.

## Output contract

Grok Build supports `plain`, `json`, and `streaming-json` headless output.
Shiba uses `streaming-json` for live chat. Each stdout line is one JSON object
with a `type` discriminator; the documented core event types are `text`,
`thought`, `end`, and `error`, and consumers must tolerate additional event
types introduced by the CLI. The `grok_cli` delegation tool captures plain
output by default, or a schema-constrained result when `json_schema` is set.

Structured delegation can additionally use `--json-schema` when a parent agent
needs a machine-readable result rather than prose.

## Updates

Use **Settings → Grok Build CLI → Check for updates** to compare the detected
binary with the current release. Install an update with the official platform
installer above, outside an active Shiba run. The next readiness refresh reads
the new `grok --version` and model catalog.

## Troubleshooting

- **No CLI badge / `grok` not found:** the official binary is not on the
  `PATH` inherited by the Shiba process. Reinstall it or fix `PATH`, then
  refresh Settings.
- **Installed but not ready:** run `grok models` in a terminal. Complete the
  sign-in flow or resolve the error it prints.
- **API-key-only CLI is not ready in Shiba:** either use `grok login`, or set
  `SHIBA_GROK_CLI_PATH` to the absolute binary path you explicitly trust before
  starting Shiba.
- **Unexpected flags or output:** run `grok --version` and verify that the
  executable came from the official `xai-org/grok-build` release, not an
  unrelated community CLI with the same command name.
- **The tool is missing for an agent:** only local agents can launch a host
  CLI, and readiness is checked at run start.
- **A CLI step hangs:** the managed process has a five-minute default timeout;
  cancelling the parent run also stops the CLI.

See also: [Chat](chat.md), [Agents](agents.md),
[Capabilities](capabilities.md), and [Configuration](configuration.md).
