# Cloud Sync

Sync backs up this machine's setup to your xAI account, or restores it on another machine. It is **not** a live mirror — it's explicit push/pull of snapshots, always started by you from the top-bar **Sync** button.

## What syncs

Agents, automations, projects, chats, workspace uploads, and (when a local model is in use) local model settings — each category as one JSON snapshot.

## Where snapshots live

Each category is serialized to a single file named `shiba-sync-<category>.json` and uploaded to **your xAI account's private file storage** via the Files API, replacing the previous snapshot. (Snapshots pushed by pre-rebrand versions as `grokdesk-sync-<category>.json` are still found on pull.) Nothing goes anywhere except your own xAI account — inspect or delete the files any time at [console.x.ai](https://console.x.ai).

## Push vs pull

- **Send to cloud (push)** — serializes each category and uploads it, replacing the prior snapshot.
- **Pull to local (pull)** — downloads the latest snapshots and **merges** them: local items with the same id are updated, new items are added, and nothing local is deleted.

The modal shows per-category counts, live per-item status, and a progress bar; the same explanation is embedded in the modal itself.

## Cloud agents

Separately from snapshot sync, **Agents → Sync cloud agents** imports heavy Grok agents from your xAI account as `CLOUD`-origin agents (no local system access; cloud tools only).

## Requirements & notes

- Needs cloud credentials (API key or OAuth) — the modal warns if neither is configured.
- Credentials themselves are **never** included in snapshots.
- Typical flow for a new machine: install → connect the same xAI account → Sync → *Pull to local*.
