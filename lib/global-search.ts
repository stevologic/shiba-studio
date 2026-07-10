// Global search across chats, runs, and the audit log. Runs and audit use
// SQLite FTS5 (see the v2 migration in db.ts); chats scan the JSON store via
// the existing searchChatSessions.

import { getDb } from './db';
import { searchChatSessions } from './chat-sessions';

export interface SearchHit {
  kind: 'chat' | 'run' | 'log';
  id: string;
  title: string;
  snippet: string;
  ts: string;
  /** In-app path the palette navigates to. */
  href: string;
}

/** Turn free text into a safe FTS5 prefix query: each token quoted + starred. */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t.replaceAll('"', '')}"*`).join(' ');
}

export async function globalSearch(raw: string, limitPerKind = 6): Promise<SearchHit[]> {
  const q = raw.trim();
  if (q.length < 2) return [];
  const fts = toFtsQuery(q);
  const hits: SearchHit[] = [];
  const db = getDb();

  if (fts) {
    try {
      const runRows = db.prepare(`
        SELECT runs.id AS id, runs.agentName AS agentName, runs.status AS status, runs.startedAt AS ts,
               snippet(runs_fts, 0, '', '', '…', 10) AS s0,
               snippet(runs_fts, 1, '', '', '…', 10) AS s1
        FROM runs_fts JOIN runs ON runs.rowid = runs_fts.rowid
        WHERE runs_fts MATCH ? ORDER BY rank LIMIT ?
      `).all(fts, limitPerKind) as Array<{ id: string; agentName: string; status: string; ts: string; s0: string; s1: string }>;
      for (const r of runRows) {
        hits.push({
          kind: 'run',
          id: r.id,
          title: `${r.agentName} · ${r.status}`,
          snippet: (r.s1 || r.s0 || '').slice(0, 160),
          ts: r.ts,
          href: `/automations?run=${encodeURIComponent(r.id)}`,
        });
      }
    } catch { /* FTS table missing (pre-migration open) — chats still work */ }

    try {
      const logRows = db.prepare(`
        SELECT audit_log.id AS id, audit_log.action AS action, audit_log.category AS category, audit_log.ts AS ts,
               snippet(audit_fts, 1, '', '', '…', 10) AS s
        FROM audit_fts JOIN audit_log ON audit_log.id = audit_fts.rowid
        WHERE audit_fts MATCH ? ORDER BY rank LIMIT ?
      `).all(fts, limitPerKind) as Array<{ id: number; action: string; category: string; ts: string; s: string }>;
      for (const r of logRows) {
        hits.push({
          kind: 'log',
          id: String(r.id),
          title: `${r.category} · ${r.action}`,
          snippet: (r.s || '').slice(0, 160),
          ts: r.ts,
          href: `/logs?q=${encodeURIComponent(q)}`,
        });
      }
    } catch { /* see above */ }
  }

  const chatSessions = await searchChatSessions(q, { includeArchived: true });
  for (const s of chatSessions.slice(0, limitPerKind)) {
    const m = (s.messages || []).find((msg) => msg?.content?.toLowerCase().includes(q.toLowerCase()));
    hits.push({
      kind: 'chat',
      id: s.id,
      title: s.title || 'Untitled chat',
      snippet: (m?.content || '').slice(0, 160),
      ts: s.updatedAt,
      href: `/chat/${encodeURIComponent(s.id)}`,
    });
  }

  return hits;
}
