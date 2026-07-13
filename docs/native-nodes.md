# Native companion nodes

Native nodes are an optional last-resort bridge from Shiba Studio to a user's desktop. They are not a second generic remote-control API and they never continuously capture the screen. The bundled helper currently runs on Windows; the signed polling protocol is platform-neutral so a separately signed macOS or Linux implementation can use the same host boundary later.

## Escalation policy

An agent may request `native_node_action` only after evaluating these stages in order:

1. connector or MCP tool;
2. Shiba's controlled browser;
3. a user-signed-in browser session;
4. native node.

The native tool requires concrete `unavailable`, `failed`, or `not_applicable` evidence for the first three stages. It is always approval-gated, including when the global tool mode is permissive, and it is unavailable to automations, schedules, board automation, and other autonomous runs.

## Pairing and release integrity

The former Doctor administration page has been removed from Studio. Existing paired helpers continue to work through the signed compatibility protocol and localhost-only `/api/native-nodes/*` endpoints, but new pairing is no longer exposed as a primary Studio workflow. The Windows launcher:

- pins the SHA-256 fingerprint of a 3072-bit RSA public key;
- verifies the detached RSA-SHA256 signature over `release-manifest.json`;
- verifies the byte length and SHA-256 digest of both PowerShell scripts;
- loads the core only after every check passes;
- pairs the signed release with a one-time, attempt-limited code; and
- stores the returned node key encrypted for the current Windows user with DPAPI.

The host independently verifies the same release signature and accepts only its known protocol and release id. A raw pairing code or node key is never stored by Studio. Node keys expire after 90 days and can be revoked immediately. This is software release integrity, not hardware attestation: a fully compromised desktop administrator can modify the runtime after verification.

Native helper endpoints require HTTPS, except for a helper running on the same loopback host. The general Studio UI and native-node administration remain localhost-only. Public release files contain no secret.

## Grants and actions

Pairing selects the node's outer capability ceiling. Every capture, click, type, clipboard, or file-open job also needs a current grant with:

- exact normalized executable identity (or the synthetic clipboard/file-open boundary);
- exact executable revision discovered by window inventory;
- exact grant revision, preventing stale approvals;
- explicit capabilities; and
- a TTL from 1 minute to 24 hours.

File-open grants include an absolute allowed path prefix. Password managers, credential tools, wallets, banks, Windows Security, registry editors, authenticators, and similar sensitive app classes are blocked on both host and helper. Notifications and inventory do not control an app but still use the signed job queue and agent approval boundary.

Each job is a signed HMAC envelope, receives a single 60-second lease, and is checked again against grant revocation/expiry when claimed. Completion and quick-entry events are signed too. Audits record pairing, grants, queueing, completion, revocation, and quick entry without persisting node secrets.

## Visible and untrusted capture

For capture, click, and type, the helper shows a topmost red indicator for the whole action. Capture is one-shot and limited to the foreground window; it returns a PNG and bounded Windows UI Automation text. The helper does not contain a background screenshot loop.

Studio labels captured accessibility, clipboard, and quick-entry text as untrusted. It scans for instruction overrides, role hijacking, secret extraction, command injection, and concealment. Multiple matches are high risk and raw text is replaced before it reaches an agent. PNGs are stored locally under the Shiba data directory and can be read only through the localhost capture route.

## Quick entry

While the helper is running, **Ctrl+Shift+Space** opens a small quick-entry window. Text or files dragged into it create a durable Shiba task and Attention item. File drops send bounded path metadata, not file contents. Duplicate signed event ids are rejected.

## Operations

Revoke an app grant when work is complete and revoke the node if the desktop is lost or reimaged. Existing automation using the localhost-only administration API can inspect release, last-seen time, current capture state, active grants, recent jobs, and helper inventory. Re-pair after a helper release changes; older or tampered manifests are rejected.
