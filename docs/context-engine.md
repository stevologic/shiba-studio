# Durable context engine

Shiba indexes chat sessions, projects, and agent runs as durable context sources in the main SQLite database. Each source has a stable citation such as `ctx:session:<session-id>:message:<message-id>` and remains inspectable independently of the model prompt.

## Long-session replay

Chat requests no longer rely on a fixed last-60-message slice. Before a request, Shiba:

1. indexes the current session messages by stable message ID;
2. deterministically compacts messages older than the recent replay window;
3. injects a bounded, citation-bearing extract of those compactions;
4. replays the newest messages within both message and estimated-token limits; and
5. exposes exact earlier wording through `session_search`.

The compactor is extractive and versioned (`extractive-v1`). It prioritizes constraints, unresolved questions, approvals, decisions, plan state, checks, and completion requirements. Regenerating a compaction from unchanged sources produces the same ID, digest, summary, and citations.

The context meter reports source, summary, replay, pinned, and attachment token estimates. Token counts are conservative deterministic estimates, not provider billing totals.

## Inspection and retrieval APIs

- `GET /api/context/scopes/{session|project|run}/<id>?limit=200&offset=0` returns paginated sources, durable compactions, provenance, and the context meter.
- `GET /api/context/sources/<source-id>` resolves one stable citation to its exact bounded source and conversation bookends.
- `POST /api/context/scopes/{type}/<id>` with `{ "action": "regenerate" }` rebuilds compactions. Use `{ "action": "pin", "sourceId": "...", "pinned": true }` to pin an exact source.
- `GET /api/context/search?q=...` or `POST /api/context/search` performs bounded literal retrieval. Optional filters are `scopeType`, `scopeId`, `projectId`, and `runId`; budgets are `maxResults` (up to 20) and `maxChars` (up to 30,000).

Search results return an exact excerpt, stable source citation, matched terms, and previous/next source bookends. Pinned sources receive a ranking boost only when they actually match the query.

## Session lifecycle

Every message exposes **Fork**, which creates a new session containing the immutable message prefix through that exact source ID. The child records a `checkpoint-branch-v1` cursor with parent session, root session, source message, ordinal, and depth. Forking never updates the parent, and ordinary session patches cannot rewrite ancestry. The server-only `rewindChatSessionToMessage` primitive is the explicitly destructive counterpart used by synchronized task-checkpoint restore; it requires exact cursor confirmation, supports an optimistic last-message guard, and rebuilds the context index after truncation.

Sessions are grouped by linked project in the chat rail. A completed assistant message increments unread state once, including detached task delivery; selecting the session advances its durable read cursor.

An **ephemeral chat** stores no Shiba memory: automatic recall and memory tools are removed server-side, memory slash commands are rejected at the API boundary, and autonomous background learning is unavailable. Forks inherit the ephemeral lifecycle. Ephemeral chats cannot be archived, are deleted explicitly with the normal close action, and the browser sends deletion for every open ephemeral session on `pagehide`.

## Durability and upgrades

Context tables use an idempotent `CREATE TABLE IF NOT EXISTS` initializer instead of owning the application schema version. This keeps the context service compatible with independent database migrations and backup restore. Server startup backfills sessions, projects, and recent runs created before the index existed; subsequent writes update their indexes directly.
