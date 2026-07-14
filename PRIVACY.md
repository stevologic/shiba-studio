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
  Reddit, Obsidian, Vercel, Netlify, Linear, and Jira calls go directly from
  your machine to those services using the credentials you provided. Reddit
  requests go through the Devvit companion endpoint you deploy; Shiba sends
  listing parameters or post content to that endpoint with its managed app
  token, and published posts are authored by the Devvit app account. No Shiba
  proxy sits in between. Posts returned by the companion can be included in
  the active model turn when an agent reads Reddit; durable tool traces retain
  only bounded listing metadata rather than post bodies or authors.
- **Linear/Jira Board sync (optional)** — a sync sends card title,
  description, priority, and labels to the selected service; **Tasks +
  columns** also sends mapped workflow status. Pulling brings those same
  fields into the local Board. Ordering, Shiba agent assignments, remote
  assignees, activity/run history, Jira sprints, and deletions are never
  synchronized.
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

Delete `~/.shiba-studio/` to remove the local configuration, credentials,
Board links, and data. This does not delete content already sent to xAI or
connected services, including Linear/Jira issues created by Board sync or
optional cloud-sync snapshots. Delete those copies through the respective
service.
