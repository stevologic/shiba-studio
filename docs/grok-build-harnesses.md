# Grok Build harnesses

This guide defines the Grok Build process boundaries that Shiba Studio
supports or documents. “Harness” here means the lifecycle and protocol used to
connect a host application to the official
[`xai-org/grok-build`](https://github.com/xai-org/grok-build) executable.

## Audited upstream

Shiba's compatibility baseline is public repository commit
[`98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`](https://github.com/xai-org/grok-build/commit/98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce).
That source snapshot declares version `0.2.102` and records upstream monorepo
revision `124d85bc5dc6e7805560215fcc6d5413944920e1` in `SOURCE_REV`. The stable
released binary exercised by Shiba is `0.2.103`. Source-snapshot version,
monorepo revision, and released-binary version are separate provenance fields.

Community projects with similar names are not mirrors or drop-in replacements
for this official Grok Build contract.

## Harness matrix

| Surface | Owner | Lifetime | Wire contract | Current use |
| --- | --- | --- | --- | --- |
| Managed headless request | Shiba | One child process per prompt | Grok Build headless output: streaming NDJSON for chat, plain or schema-constrained output for delegation | CLI-routed chat and `grok_cli` delegation |
| Persistent IDE agent | ACP client | Long-lived child process | ACP JSON-RPC over stdin/stdout | Upstream IDE capability; Shiba does not currently launch it |
| External harness grant | External worker/operator | One grant-bound session | Shiba attachment metadata plus authenticated callbacks | Attaches evidence/status to a bounded Shiba task; never ambient process discovery |

## Managed headless requests

Shiba currently launches the official binary as a bounded one-shot process.
The invariant command envelope is:

```text
grok --no-auto-update -p <prompt> --output-format <format>
```

CLI-routed chat selects `streaming-json`; `grok_cli` delegation selects plain
output unless a JSON schema constrains the result. Shiba may also add the
selected model, working directory, turn limit, reasoning effort, tool
restrictions, verification, best-of-N, or JSON-schema flags for a specific
request. The important lifecycle properties are:

- the selected workspace is explicit;
- the process is launched without a command shell;
- streaming chat stdout is parsed as newline-delimited JSON, while delegation
  captures the selected non-streaming format;
- cancellation and timeout stop the child process;
- automatic binary updates are disabled for the managed request;
- each invocation exits after one prompt.

The documented core stream events are `text`, `thought`, `end`, and `error`.
The event set is extensible, so a client must not fail merely because a newer
binary emits another event type.

This is the harness behind `/api/grok-cli/stream` and the local-agent
`grok_cli` tool.

Because headless mode cannot display approval prompts, a tools-enabled chat or
CLI-model run receives `bypassPermissions` only when Shiba's global approval
mode is explicitly set to **YOLO**. In Ask mode, would-prompt actions are denied.
The `grok_cli` tool may also receive unattended approval after the parent
agent's normal Shiba approval gate authorizes that delegation. Tools-off and
read-only runs never receive the bypass mode. Upstream deny rules, hooks, and
administrative locks still apply.

## Persistent IDE agent over ACP

Grok Build also provides a persistent editor harness:

```text
grok agent stdio
```

This command speaks the Agent Client Protocol (ACP): newline-delimited JSON-RPC
over the process's stdin and stdout. An ACP client initializes the connection,
creates or loads sessions, sends prompts, receives streamed message/thought and
tool-call updates, and answers permission requests. The process can serve many
turns and maintain session state until the client shuts it down.

This is the documented upstream integration point for an IDE or editor that
wants to own a long-lived Grok process. It is not the transport currently used
by Shiba's Monaco IDE, chat route, or `grok_cli` tool. Those surfaces continue
to use the managed one-shot harness above. Describing ACP support therefore
does not imply that Shiba has started a background Grok process.

## External harness grants

Shiba's `/api/harness-grants` family is a separate attachment and callback
contract. A grant:

- names one workspace and an explicit set of allowed actions;
- expires after a bounded TTL;
- attaches one external worker session to a child task;
- accepts authenticated status and typed-evidence callbacks;
- can be revoked, which cancels the child task.

Issuing or starting a grant does **not** scan the host, find a CLI by name, or
spawn an ambient Grok/Codex/Claude process. The external worker or its operator
is responsible for launching its own harness and returning callbacks with the
grant credential. This separation prevents a metadata attachment from becoming
implicit host-code execution.

See [API Reference](api.md#remote-companion-and-external-harnesses) for the
endpoints and [Grok Build CLI](cli.md) for installation and readiness.

## Operational rules

- Use `grok models` for authenticated readiness, not merely `grok --version`.
- Keep the official binary on the `PATH` inherited by Shiba.
- Shiba does not pass an ambient `XAI_API_KEY` to a PATH-discovered executable.
  Use CLI-owned login credentials, or pin an operator-trusted absolute binary
  path with `SHIBA_GROK_CLI_PATH` when API-key authentication is required.
  Windows pins must name an existing `.exe`; Unix pins must be executable.
- Update the binary explicitly outside an active managed request.
- Treat the CLI's own credentials, sessions, configuration, plugins, skills,
  hooks, and MCP configuration as Grok Build-owned state.
- Do not substitute an unrelated community package solely because it exposes a
  command named `grok`.
