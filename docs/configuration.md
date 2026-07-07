# Configuration

## Settings reference

Settings is a card grid; each card maps to a concern:

| Card | Controls |
| --- | --- |
| **xAI Grok API Key** | Cloud token from console.x.ai; save & validate, test |
| **OAuth with X** | OAuth 2.0 sign-in (SuperGrok / X Premium+), manual callback fallback, disconnect, and — when both are configured — which cloud credential to prefer |
| **Local Models** | Enable any OpenAI-compatible server (LM Studio, Ollama, llama.cpp), base URL, connection test, and a per-model allowlist that filters every picker in the app |
| **Default Model** | The model used by Grok Chat and new agents (cloud or local) |
| **Grok Build CLI** | Auto-detected from PATH; version, path, and an update checker (`grok update --check`) |
| **Agent Behavior** | Tool approval mode (YOLO auto-run vs Ask-before-act), AGENTS.md/CLAUDE.md injection, and global instructions prepended to every agent and chat |
| **Monthly Usage Quota** | The budget the chat QUOTA pill reports against (estimated from xAI per-token rates; local runs are $0) |
| **Default Workspace** | Root folder for uploads, new agents, and the workspace explorer |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROKDESK_DATA_DIR` | `~/.grokdesk/data` | Where all runtime data lives (config, SQLite, uploads, screenshots) |
| `GROKDESK_SECRET_KEY` | `~/.grokdesk/grokdesk.key` file | 64-hex-char AES key for headless deployments (overrides the key file) |
| `SHIBA_GIT_COMMIT` | resolved via `git rev-parse` | Overrides the commit shown in the sidebar/footer for non-git installs |

## Data locations

| Path | Contents |
| --- | --- |
| `~/.grokdesk/grokdesk.key` | Machine encryption key — **back this up**; without it encrypted credentials can't be read |
| `~/.grokdesk/data/config.json` | Settings; credential fields stored as `enc:v1:…` ciphertext |
| `~/.grokdesk/data/grokdesk.db` | SQLite (WAL): agent runs with full traces, audit log, agent memory |
| `~/.grokdesk/data/` | Agents, chat sessions, projects, global uploads, screenshots |

Legacy in-repo `data/` directories migrate to `~/.grokdesk/data` automatically on first start.

## Security model

- **Local-first:** no telemetry; outbound traffic goes only to xAI and integrations you configure.
- **Secrets:** AES-256-GCM at rest (`enc:v1:` prefix), machine key outside the project, plaintext migrated on load, never included in cloud-sync snapshots.
- **Audit:** every consequential action (runs, chats, config, integrations, sync, git, sub-browser) lands in the Logs page with agent/model provenance and CSV/JSON export.
- **Current limitations** (see [TODO.md](../TODO.md) before exposing beyond localhost): the server binds all interfaces with unauthenticated APIs that can execute shell commands via agents, and tool approval defaults to YOLO. Treat the app as single-user on a trusted machine, or front it with your own auth and bind `127.0.0.1`.
