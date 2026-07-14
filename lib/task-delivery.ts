// Durable task outbox dispatcher. The SQLite row is the source of truth and
// its id is reused as the destination message id for idempotent retries.

import { claimOutbox, finishOutbox, pruneTaskDeliveryReceipts } from './task-ledger';
import { isAutomationMaintenanceActive } from './automation-maintenance';

interface DeliveryGlobals {
  __shibaTaskDeliveryPromise?: Promise<number>;
  __shibaTaskDeliveryTimer?: ReturnType<typeof setInterval>;
  __shibaTaskDeliveryRetentionAt?: number;
}

const g = globalThis as unknown as DeliveryGlobals;
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

function staleClaim(error: unknown): boolean {
  return /claim is no longer current/i.test(error instanceof Error ? error.message : String(error));
}

async function deliverOne(item: ReturnType<typeof claimOutbox>[number]): Promise<void> {
  if (item.target.startsWith('chat:')) {
    const sessionId = item.target.slice('chat:'.length);
    const { appendChatMessage } = await import('./chat-sessions');
    const payload = item.payload;
    const status = String(payload.status || 'completed');
    const title = String(payload.title || 'Background task update');
    const body = String(payload.body || 'Task finished.');
    const taskId = String(payload.taskId || item.taskId);
    const saved = await appendChatMessage(sessionId, {
      id: item.id,
      role: 'assistant',
      content: [
        `Task update: **${title}**`,
        '',
        body,
        '',
        `[Open task](/tasks/${encodeURIComponent(taskId)}) | Status: ${status}`,
      ].join('\n'),
      agentName: 'Shiba Task System',
      createdAt: new Date().toISOString(),
    });
    if (!saved) {
      // The task result remains durable. A deleted originating chat is a
      // terminal destination, not a transient error worth retrying.
      try {
        const { audit } = await import('./audit-log');
        audit('run', 'background delivery skipped', 'Originating chat session no longer exists', {
          taskId: item.taskId,
          sessionId,
          outboxId: item.id,
        });
      } catch { /* audit is derived bookkeeping */ }
      finishOutbox(item.id, { delivered: true, expectedAttempts: item.attempts });
      return;
    }
    finishOutbox(item.id, { delivered: true, expectedAttempts: item.attempts });
    return;
  }
  throw new Error(`Unsupported task delivery target: ${item.target}`);
}

export function processTaskOutbox(limit = 20): Promise<number> {
  if (g.__shibaTaskDeliveryPromise) return g.__shibaTaskDeliveryPromise;
  if (isAutomationMaintenanceActive()) return Promise.resolve(0);
  const run = (async () => {
    const claimed = claimOutbox(limit);
    let delivered = 0;
    for (const item of claimed) {
      try {
        await deliverOne(item);
        delivered += 1;
      } catch (error) {
        // A newer worker reclaimed this row after its lease expired. Its
        // attempt owns the state now; this stale worker must not overwrite it.
        if (staleClaim(error)) continue;
        const attempts = item.attempts;
        const delayMs = Math.min(15 * 60_000, Math.max(5_000, 2 ** Math.min(attempts, 8) * 1_000));
        try {
          finishOutbox(item.id, {
            delivered: false,
            error: error instanceof Error ? error.message : String(error),
            retryAt: new Date(Date.now() + delayMs).toISOString(),
            expectedAttempts: item.attempts,
          });
        } catch (finishError) {
          if (!staleClaim(finishError)) throw finishError;
        }
      }
    }
    const now = Date.now();
    if (now - (g.__shibaTaskDeliveryRetentionAt || 0) >= RETENTION_SWEEP_INTERVAL_MS) {
      g.__shibaTaskDeliveryRetentionAt = now;
      try {
        pruneTaskDeliveryReceipts({ nowMs: now });
      } catch (error) {
        // Delivery is already authoritative. Retention is best-effort and the
        // next throttled pump pass will retry without changing receipt state.
        console.error('[task-delivery] receipt retention sweep failed', error);
      }
    }
    return delivered;
  })();
  g.__shibaTaskDeliveryPromise = run.finally(() => {
    g.__shibaTaskDeliveryPromise = undefined;
  });
  return g.__shibaTaskDeliveryPromise;
}

export function startTaskDeliveryPump(): void {
  if (g.__shibaTaskDeliveryTimer || isAutomationMaintenanceActive()) return;
  void processTaskOutbox().catch((error) => {
    console.error('[task-delivery] initial outbox pump failed', error);
  });
  g.__shibaTaskDeliveryTimer = setInterval(() => {
    void processTaskOutbox().catch((error) => {
      console.error('[task-delivery] outbox pump failed', error);
    });
  }, 2_000);
  g.__shibaTaskDeliveryTimer.unref?.();
}

export async function stopTaskDeliveryPump(): Promise<void> {
  if (g.__shibaTaskDeliveryTimer) {
    clearInterval(g.__shibaTaskDeliveryTimer);
    g.__shibaTaskDeliveryTimer = undefined;
  }
  const active = g.__shibaTaskDeliveryPromise;
  if (active) await active;
}
