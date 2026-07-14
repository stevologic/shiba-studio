# Configuration

<img src="images/settings.png" alt="Settings: model sources, agent behavior, cost & safety guardrails, and backup & restore" width="880" />

## Settings reference

Settings is a card grid; each card maps to a concern:

| Card | Controls |
| --- | --- |
| **xAI Grok API Key** | Cloud token from console.x.ai; save & validate, test |
| **xAI Management Key** | Optional key that backports authoritative team usage/billing into the Usage page |
| **OAuth with X** | OAuth 2.0 sign-in (SuperGrok / X Premium+), manual callback fallback, disconnect, and — when both are configured — which cloud credential to prefer |
| **Local Models** | Enable any OpenAI-compatible server (LM Studio, Ollama, llama.cpp), base URL, connection test, and a per-model allowlist that filters every picker in the app |
| **Default Model** | The model used by Grok Chat and new agents. When both an API key and OAuth are connected, cloud models appear twice — `· OAuth` (SuperGrok/Premium+ quota) and `· Token` (pay-as-you-go) — so any picker can choose the credential per selection |
| **Default Grok voice & speed** | Studio-wide TTS voice and speech rate for Grok Chat and voice mode |
| **Grok Build CLI** | Auto-detected from PATH; version, path, and an update checker (`grok update --check`) |
| **Agent Behavior** | Tool approval mode (Ask-before-act default vs YOLO auto-run), AGENTS.md/CLAUDE.md injection, and global instructions prepended to every agent and chat |
| **Default Workspace** | Root folder for uploads, new agents, and the workspace explorer |
| **Cost & safety** | Monthly + daily spend limits with an optional hard stop (blocks new cloud runs/chats at the limit), max concurrent runs, per-run token cap, and retention windows for runs and the audit log |
| **Backup & restore** | One-file export of settings, agents, chats, projects, runs, and the audit log (includes the encryption key — treat like a password); restore on any machine |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIBA_DATA_DIR` | `~/.shiba-studio/data` | Where all runtime data lives (config, SQLite, uploads, screenshots) |
| `SHIBA_PROJECT_ROOT` | npm/shell working directory | Source/workspace root for launchers that start the process from another directory |
| `SHIBA_SECRET_KEY_FILE` | `~/.shiba-studio/shiba-studio.key` | Overrides the machine key-file path; the Docker image sets this to `/data/shiba-studio.key` so secrets survive container replacement |
| `SHIBA_SECRET_KEY` | `~/.shiba-studio/shiba-studio.key` file | 64-hex-char AES key for headless deployments (overrides the key file) |
| `SHIBA_GIT_COMMIT` | resolved via `git rev-parse` | Overrides the commit shown in the sidebar/footer for non-git installs |
| `PUPPETEER_SKIP_DOWNLOAD` | unset | Set to `1` before `npm install` to skip the ~150 MB Chromium download (slim install). Browser tools then explain how to fetch it on first use |
| `SHIBA_TEST_DATA_DIR` | unset | Persistent data dir for `npm test` (default: a fresh temp dir per run, so tests never touch your live data) |
| `SHIBA_MDNS_HOST` | `shiba.local` | The `.local` name(s) the app advertises via mDNS — comma-separated; a bare label gets `.local` appended |
| `SHIBA_MDNS` | on | Set to `off` to disable mDNS advertising entirely |
| `SHIBA_LAN` | unset | Set by `npm run dev:lan`/`start:lan`; makes mDNS advertise the machine's LAN IP (network-wide) instead of `127.0.0.1` |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | unset | A bundled Google OAuth client for Drive. When both are set, Capabilities → Google Drive becomes zero-setup — users just click **Sign in with Google**. Unset = each user adds their own client under the card's Advanced section. See [Capabilities](capabilities.md) |

Put these in a `.env.local` file in the project root (gitignored) or your shell environment; see `.env.example`.

Reddit has no Shiba environment variables. Configure its Devvit External Endpoint origin and managed app token as one complete pair in the Reddit Devvit integration card; the token remains encrypted in Shiba's server-side credential store. Per-agent overrides likewise require both values, or neither to use the global connection.

## X MCP browser sign-in

The X MCP preset uses X's official `xurl` bridge. Register the exact OAuth 2.0 callback `http://localhost:8080/callback` in your X developer app, then save that app's Client ID and Client Secret under the X integration. Choosing **Add & sign in with X** opens X's authorization page in the system browser. After consent, `xurl` caches and refreshes the token, so later MCP connections sign in automatically while the X session remains valid.

These OAuth 2.0 app credentials are separate from the OAuth 1.0a keys used by Shiba's built-in X tools and from xAI/SuperGrok sign-in. Shiba encrypts its saved client secret and gives each Client ID a private xurl home under the Shiba data directory, so an existing global `~/.xurl` account cannot be reused accidentally. The official bridge stores its own app credentials and access/refresh tokens as a permission-restricted plaintext YAML file inside that private home; it follows `xurl`'s storage lifecycle and is not removed when the Shiba MCP entry is deleted.

Automatic browser consent is available when Shiba runs directly on a desktop. The slim Docker image has no browser and cannot complete xurl's first-time callback from inside the container; authenticate that isolated xurl profile before containerizing it, or run Shiba from source for the first consent. Once cached in the persistent `/data/x-mcp` volume, token reuse and refresh are automatic.

The pre-rebrand names `GROKDESK_DATA_DIR` / `GROKDESK_SECRET_KEY` are still honored as fallbacks so older deployments keep working.

## Reach the app by name (mDNS / `shiba.local`)

On start the app advertises itself over multicast DNS so you can open it at
**`http://shiba.local`** (bare name — a port-80 redirect forwards to the app port; `http://shiba.local:3000` also works) instead of an IP address — no hosts-file editing.

- **`npm run dev` / `start` (localhost):** `shiba.local` resolves to `127.0.0.1`
  on this machine — a convenient local alias.
- **`npm run dev:lan` / `start:lan` (LAN):** `shiba.local` resolves to this
  machine's **LAN IP**. Network clients are restricted to the scoped
  `/companion` PWA; the full Studio and its generic APIs remain localhost-only.
  The launcher keeps Next on a private loopback port and exposes a small outer
  proxy that classifies clients from their TCP address; changing `Host` or
  `X-Forwarded-*` headers cannot turn a network request into a local request.
  Remote access is disabled until it is enabled and a device is paired from
  `http://localhost:3000/companion/admin`. Only use LAN mode on a trusted
  network and read [SECURITY.md](../SECURITY.md) first.

Resolution needs an mDNS resolver on the client: Windows 10+ and macOS have it
built in, Linux via Avahi/nss-mdns. Rename with `SHIBA_MDNS_HOST`
(comma-separated for several names, e.g. `mybox.local`) or turn it off with
`SHIBA_MDNS=off`.

## Secure remote companion

Open `/companion/admin` through `localhost` on the Shiba host to explicitly
enable remote access, choose device scopes, and create a short-lived one-time
pairing URL. Pairing codes and device keys are stored only as hashes; device
keys expire, can be revoked individually, and stop working immediately when
remote access is disabled. The companion exposes redacted task/evidence
summaries and exact pending approvals, never workspace file contents,
workspace roots, integration configuration, or raw command evidence.

The optional `action:voice` device permission adds consent-gated microphone
requests. Recording requires HTTPS because browsers restrict microphone and
WebCrypto APIs in insecure contexts. The phone reviews the recording before
sending it with a stable idempotency key, byte count, and SHA-256 digest. The
handler authenticates and authorizes the device again, streams only supported
audio up to 50 MB into generated local meeting storage, fixes retention at one
day, and uses the host's xAI credentials for diarized transcription. It then
creates and dispatches one durable task from the transcript. Retries cannot
duplicate the recording, transcription, or task. Companion status contains
only the user-supplied title, phase, task identifier, and a sanitized error;
raw audio and transcript text are never returned to or cached by the PWA.

For an installable PWA and encrypted offline summaries, serve the companion in
a secure browser context (HTTPS or localhost). If a same-machine TLS proxy is
used, it must connect to the LAN address rather than the loopback address;
loopback is intentionally trusted as the local Studio user. Plain LAN HTTP can
use live controls but browsers do not allow service workers or WebCrypto-backed
offline storage there. There is no public relay.

## Data locations

| Path | Contents |
| --- | --- |
| `~/.shiba-studio/shiba-studio.key` | Machine encryption key — **back this up**; without it encrypted credentials can't be read |
| `~/.shiba-studio/data/config.json` | Settings; credential fields stored as `enc:v1:…` ciphertext |
| `~/.shiba-studio/data/shiba-studio.db` | SQLite (WAL): agent runs with full traces, audit log, agent memory |
| `~/.shiba-studio/data/` | Agents, chat sessions, projects, global uploads, screenshots |

Upgrades are automatic: a legacy `~/.grokdesk` directory (including its key and database) is renamed to `~/.shiba-studio` on first start, and legacy in-repo `data/` directories migrate the same way.

## Security model

- **Local-first:** no telemetry; outbound traffic goes only to xAI and integrations you configure.
- **Secrets:** AES-256-GCM at rest (`enc:v1:` prefix), machine key outside the project, plaintext migrated on load, never included in cloud-sync snapshots.
- **Audit:** every consequential action (runs, chats, config, integrations, sync, git, sub-browser) lands in the Logs page with agent/model provenance and CSV/JSON export.
- **Network boundary:** `npm run dev`/`npm run start` bind `127.0.0.1` only. In explicit `dev:lan`/`start:lan` mode, an outer listener classifies the TCP peer and forwards to a loopback-only Next server; non-loopback requests are redirected to `/companion`, while generic Studio APIs and companion administration are rejected even if a client spoofs `Host: localhost`. Companion data/actions require a scoped, expiring, revocable device key in addition to same-origin checks. Localhost Studio APIs remain unauthenticated for the single local user. The terminal WebSocket bridge refuses foreign origins, and tool approval defaults to **Ask**. Full threat model: [SECURITY.md](../SECURITY.md).
