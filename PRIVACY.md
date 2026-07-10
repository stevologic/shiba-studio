# Privacy

Shiba Studio is **local-first software with zero telemetry**. This page is the
complete list of where your data lives and where it can travel.

## What stays on your machine (everything, by default)

| Data | Where |
| --- | --- |
| Settings & credentials | `~/.shiba-studio/data/config.json` — secrets AES-256-GCM encrypted |
| Machine encryption key | `~/.shiba-studio/shiba-studio.key` |
| Agents, chats, projects | `~/.shiba-studio/data/` (JSON) |
| Runs, audit log, agent memory | `~/.shiba-studio/data/shiba-studio.db` (SQLite) |
| Screenshots & uploads | `~/.shiba-studio/data/` |

Shiba Studio never sends analytics, crash reports, usage statistics, or any
other telemetry anywhere. There is no account, no sign-up, and no server other
than the one running on your own machine.

## What leaves your machine (only what you configure)

- **xAI / Grok** — your prompts, chat history in the active conversation,
  attached files/images, and workspace context you bring into a chat or agent
  run are sent to `api.x.ai` (or your OAuth-authenticated Grok endpoint) to
  generate responses. If you use a **local model server** instead, that
  traffic stays on your machine.
- **Integrations you connect** — GitHub, Slack, Google Drive, Discord, X,
  Obsidian, Vercel, and Netlify calls go directly from your machine to those
  services using the credentials you provided. No proxy in between.
- **Web tools you invoke** — web search, `/fetch`, and the sub-browser load
  the sites you point them at, from your machine.
- **Cloud sync (optional, off by default)** — snapshots are uploaded to your
  own **xAI account's private file storage** (via the xAI Files API), under
  the credentials you already use for Grok. Credential secrets
  are excluded from snapshots.

## Your responsibility to third parties

Traffic to xAI and connected integrations is governed by those services'
terms and privacy policies. If you point agents at private repositories,
channels, or vaults, their content can appear in prompts sent to xAI — scope
your agents' integrations accordingly.

## Deleting your data

Delete `~/.shiba-studio/` and it is all gone. There is nothing to delete
anywhere else, because nothing was ever sent anywhere else.
