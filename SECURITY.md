# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via GitHub:
[github.com/stevologic/shiba-studio/security/advisories/new](https://github.com/stevologic/shiba-studio/security/advisories/new)
(Repository → Security → "Report a vulnerability"). If you can't use GitHub,
open an issue asking for a private contact channel — do **not** post exploit
details publicly before a fix ships.

You can expect an acknowledgement within a few days. Fixes are released as
ordinary versions; there are no long-lived support branches — always run the
latest release.

## Threat model

Shiba Studio is a **single-user, local-first** application. It is designed to
run on one trusted machine, serving one trusted user on `localhost`. Its agents
deliberately have real power: they read and write files, run shell commands,
and drive a browser. The security goal is that **only you** — not other
machines on the network and not other websites in your browser — can reach
that power.

| Boundary | Protection |
| --- | --- |
| **Network** | `npm run dev` / `npm run start` bind `127.0.0.1` only. `dev:lan` / `start:lan` opt into LAN exposure — do that only behind your own auth/reverse proxy. |
| **Cross-site (CSRF / drive-by)** | `proxy.ts` rejects any `/api/*` request with a non-loopback `Origin` or a `Sec-Fetch-Site: cross-site` navigation, so a malicious website open in the same browser cannot drive agents or the shell. OAuth callbacks are exempt (protected by the `state` parameter). |
| **Terminal bridge** | The node-pty WebSocket bridge binds `127.0.0.1` and rejects browser connections from non-loopback origins (WebSockets are not covered by CORS). |
| **Secrets at rest** | All credentials (xAI API key, OAuth tokens, integration secrets) are AES-256-GCM encrypted (`enc:v1:` prefix). The machine key lives outside the project at `~/.shiba-studio/shiba-studio.key`, or supply `SHIBA_SECRET_KEY` (64 hex chars) for headless installs. Plaintext stores migrate to encrypted form on first load. Secrets are excluded from cloud-sync snapshots. |
| **Tool execution** | Tool approval defaults to **Ask** — sensitive tools (`shell_exec`, `fs_write`, browser actions, posting to integrations) require an explicit approval per call. YOLO mode is an explicit opt-in under Settings → Agent Behavior. |
| **Audit** | Every consequential action (runs, chats, config changes, integration calls, git, sub-browser) is recorded in the audit log (Logs page) with provenance and CSV/JSON export. |

### Non-goals

- **Multi-user isolation.** There is no login, no roles, no per-user data
  separation. Do not host Shiba Studio as a shared service.
- **Sandboxing the agents from *you*.** Agents act with your OS user's
  privileges by design. Approval mode is the control surface.
- **Protecting against a compromised machine.** If an attacker can read
  `~/.shiba-studio/shiba-studio.key`, they can decrypt the credential store.

## Known accepted risks

- `npm audit` currently reports moderate advisories in `postcss` as bundled
  *inside* Next.js itself; the only automated "fix" is a major downgrade of
  Next. This is tracked upstream and re-checked on every Next.js upgrade.
- Local model servers (LM Studio/Ollama) and the Obsidian Local REST API are
  contacted over localhost HTTP(S); the Obsidian REST client accepts its
  self-signed certificate by design.

## Scope

In scope: anything reachable from the network or another browser origin
without user interaction; credential-store weaknesses; path escapes beyond
an intended root (e.g. the Obsidian vault boundary).

Out of scope: attacks requiring the attacker to already run code as the user,
social engineering, and denial-of-service against your own machine.
