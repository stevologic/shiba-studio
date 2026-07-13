import { getDb } from './db';

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS oauth_generations (
      provider TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
}

export function currentOAuthGeneration(provider: 'xai' | 'reddit'): number {
  ensureSchema();
  const row = getDb().prepare('SELECT generation FROM oauth_generations WHERE provider = ?')
    .get(provider) as { generation: number } | undefined;
  return Number(row?.generation) || 0;
}

export function advanceOAuthGeneration(provider: 'xai' | 'reddit'): number {
  ensureSchema();
  const now = new Date().toISOString();
  const row = getDb().prepare(`
    INSERT INTO oauth_generations (provider, generation, updatedAt) VALUES (?, 1, ?)
    ON CONFLICT(provider) DO UPDATE SET generation = generation + 1, updatedAt = excluded.updatedAt
    RETURNING generation
  `).get(provider, now) as { generation: number } | undefined;
  if (!row) throw new Error(`Could not advance ${provider} OAuth revocation generation`);
  return Number(row.generation);
}
