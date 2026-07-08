# Configuration

## Settings reference

Settings is a card grid; each card maps to a concern:

| Card | Controls |
| --- | --- |
| **xAI Grok API Key** | Cloud token from console.x.ai; save & validate, test |
| **OAuth with X** | OAuth 2.0 sign-in (SuperGrok / X Premium+), manual callback fallback, disconnect, and — when both are configured — which cloud credential to prefer |
| **Local Models** | Enable any OpenAI-compatible server (LM Studio, Ollama, llama.cpp), base URL, connection test, and a per-model allowlist that filters every picker in the app |
| **Default Model** | The model used by Grok Chat and new agents. When both an API key and OAuth are connected, cloud models appear twice — `· OAuth` (SuperGrok/Premium+ quota) and `· Token` (pay-as-you-go) — so any picker can choose the credential per selection |
| **Grok Build CLI** | Auto-detected from PATH; version, path, and an update checker (`grok update --check`) |
| **Agent Behavior** | Tool approval mode (YOLO auto-run vs Ask-before-act), AGENTS.md/CLAUDE.md injection, and global instructions prepended to every agent and chat |
| **Monthly Usage Quota** | The budget the chat QUOTA pill reports against (estimated from xAI per-token rates; local runs are $0) |
| **Default Workspace** | Root folder for uploads, new agents, and the workspace explorer |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIBA_DATA_DIR` | `~/.shiba-studio/data` | Where all runtime data lives (config, SQLite, uploads, screenshots) |
| `SHIBA_SECRET_KEY` | `~/.shiba-studio/shiba-studio.key` file | 64-hex-char AES key for headless deployments (overrides the key file) |
| `SHIBA_GIT_COMMIT` | resolved via `git rev-parse` | Overrides the commit shown in the sidebar/footer for non-git installs |

The pre-rebrand names `GROKDESK_DATA_DIR` / `GROKDESK_SECRET_KEY` are still honored as fallbacks so older deployments keep working.

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
- **Current limitations** (see [TODO.md](../TODO.md) before exposing beyond localhost): the server binds all interfaces with unauthenticated APIs that can execute shell commands via agents, and tool approval defaults to YOLO. Treat the app as single-user on a trusted machine, or front it with your own auth and bind `127.0.0.1`.
