import { getDb } from './db';
import type { GrokCliTemporaryResourceReport } from './grok-cli';
import { dataDir } from './data-paths';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const DEFAULT_PAIRING_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_PAIRING_BATCH_SIZE = 1_000;

export interface TransientResourceIntegrityReport {
  companionPairingsRemoved: number;
  nativePairingsRemoved: number;
  companionActionReceiptsCompleted: number;
  companionActionReceiptsFailed: number;
  xaiOAuthPendingRemoved: number;
  redditOAuthPendingRemoved: number;
  grokCli: GrokCliTemporaryResourceReport;
  errors: string[];
}

export interface TransientResourceIntegrityOptions {
  nowMs?: number;
  pairingRetentionMs?: number;
  pairingBatchSize?: number;
  grokTemporaryMinAgeMs?: number;
  temporaryRoot?: string;
}

function emptyGrokCliReport(): GrokCliTemporaryResourceReport {
  return {
    isolatedHomesRemoved: 0,
    promptFilesRemoved: 0,
    youngResourcesRetained: 0,
    errors: [],
  };
}

async function removeLegacyRedditOAuthPending(): Promise<boolean> {
  const target = dataDir('reddit-oauth-pending.json');
  try {
    await fs.unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function prunePairingChallenges(
  nowMs: number,
  retentionMs: number,
  batchSize: number,
): { companion: number; native: number } {
  const db = getDb();
  const cutoff = new Date(nowMs - retentionMs).toISOString();
  const remove = (table: 'companion_pairings' | 'native_node_pairings'): number => {
    if (!tableExists(table)) return 0;
    return Number(db.prepare(`
      DELETE FROM ${table}
      WHERE id IN (
        SELECT id FROM ${table}
        WHERE expiresAt <= ?
           OR (consumedAt IS NOT NULL AND consumedAt <= ?)
           OR (attempts >= maxAttempts AND createdAt <= ?)
        ORDER BY createdAt ASC, id ASC
        LIMIT ?
      )
    `).run(cutoff, cutoff, cutoff, batchSize).changes) || 0;
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = {
      companion: remove('companion_pairings'),
      native: remove('native_node_pairings'),
    };
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

/**
 * Reconcile short-lived control-plane data that has no durable business value
 * after expiry. Every domain uses its own lock/transaction, so an abandoned
 * challenge can be removed without racing a newly-created live one.
 */
export async function reconcileTransientResources(
  options: TransientResourceIntegrityOptions = {},
): Promise<TransientResourceIntegrityReport> {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const pairingRetentionMs = Math.max(
    60_000,
    Number(options.pairingRetentionMs) || DEFAULT_PAIRING_RETENTION_MS,
  );
  const pairingBatchSize = Math.max(
    1,
    Math.min(10_000, Math.floor(Number(options.pairingBatchSize) || DEFAULT_PAIRING_BATCH_SIZE)),
  );
  const report: TransientResourceIntegrityReport = {
    companionPairingsRemoved: 0,
    nativePairingsRemoved: 0,
    companionActionReceiptsCompleted: 0,
    companionActionReceiptsFailed: 0,
    xaiOAuthPendingRemoved: 0,
    redditOAuthPendingRemoved: 0,
    grokCli: emptyGrokCliReport(),
    errors: [],
  };

  try {
    const removed = prunePairingChallenges(nowMs, pairingRetentionMs, pairingBatchSize);
    report.companionPairingsRemoved = removed.companion;
    report.nativePairingsRemoved = removed.native;
  } catch (error) {
    report.errors.push(`pairing challenges: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const { reconcileInterruptedCompanionActions } = await import('./companion-auth');
    const receipts = reconcileInterruptedCompanionActions(nowMs);
    report.companionActionReceiptsCompleted = receipts.completed;
    report.companionActionReceiptsFailed = receipts.failed;
  } catch (error) {
    report.errors.push(`companion action receipts: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [xai, reddit, grok] = await Promise.allSettled([
    import('./xai-oauth').then(({ pruneExpiredOAuthPending }) => pruneExpiredOAuthPending(nowMs)),
    removeLegacyRedditOAuthPending(),
    import('./grok-cli').then(({ reconcileGrokCliTemporaryResources }) =>
      reconcileGrokCliTemporaryResources({
        nowMs,
        minAgeMs: options.grokTemporaryMinAgeMs,
        temporaryRoot: options.temporaryRoot,
      })),
  ]);

  if (xai.status === 'fulfilled') report.xaiOAuthPendingRemoved = xai.value ? 1 : 0;
  else report.errors.push(`xAI OAuth pending: ${xai.reason instanceof Error ? xai.reason.message : String(xai.reason)}`);
  if (reddit.status === 'fulfilled') report.redditOAuthPendingRemoved = reddit.value ? 1 : 0;
  else report.errors.push(`legacy Reddit OAuth pending: ${reddit.reason instanceof Error ? reddit.reason.message : String(reddit.reason)}`);
  if (grok.status === 'fulfilled') {
    report.grokCli = grok.value;
    report.errors.push(...grok.value.errors.map((error) => `Grok CLI temporary resource: ${error}`));
  } else {
    report.errors.push(`Grok CLI temporary resources: ${grok.reason instanceof Error ? grok.reason.message : String(grok.reason)}`);
  }
  return report;
}
