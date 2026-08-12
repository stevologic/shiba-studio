import { getDb } from './db';

const MAX_INBOX = 80;

function ensureAgentInboxSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      toAgentId TEXT NOT NULL,
      fromAgentId TEXT NOT NULL,
      msg TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_to ON agent_inbox(toAgentId, id);
  `);
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function postToAgentInbox(toAgentId: string, fromAgentId: string, message: string) {
  const to = clip(toAgentId, 120);
  const from = clip(fromAgentId, 120);
  const msg = clip(message, 8_000);
  if (!to || !from || !msg) return;
  ensureAgentInboxSchema();
  const db = getDb();
  db.prepare('INSERT INTO agent_inbox (toAgentId, fromAgentId, msg, ts) VALUES (?, ?, ?, ?)').run(
    to, from, msg, new Date().toISOString(),
  );
  db.prepare(`
    DELETE FROM agent_inbox WHERE id NOT IN (
      SELECT id FROM agent_inbox ORDER BY id DESC LIMIT ?
    )
  `).run(MAX_INBOX);
}

export function drainInbox(agentId: string): string[] {
  const to = clip(agentId, 120);
  if (!to) return [];
  ensureAgentInboxSchema();
  const db = getDb();
  const mine = db.prepare(
    'SELECT fromAgentId, msg, ts FROM agent_inbox WHERE toAgentId = ? ORDER BY id ASC',
  ).all(to) as Array<{ fromAgentId: string; msg: string; ts: string }>;
  db.prepare('DELETE FROM agent_inbox WHERE toAgentId = ?').run(to);
  return mine.map((row) => `[peer ${row.fromAgentId} @ ${row.ts}] ${row.msg}`);
}
