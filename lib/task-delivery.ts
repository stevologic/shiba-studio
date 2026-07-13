// Durable task outbox dispatcher. The SQLite row is the source of truth and
// its id is reused as the destination message id for idempotent retries.

import { claimOutbox, finishOutbox } from './task-ledger';

interface DeliveryGlobals {
  __shibaTaskDeliveryPromise?: Promise<number>;
  __shibaTaskDeliveryTimer?: ReturnType<typeof setInterval>;
}

const g = globalThis as unknown as DeliveryGlobals;

async function deliverOne(item: ReturnType<typeof claimOutbox>[number]): Promise<void> {
  if (item.target === 'attention') {
    // The terminal transition inserted the Attention row in the same
    // transaction as this outbox item. Nothing external remains to write.
    finishOutbox(item.id, { delivered: true });
    return;
  }
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
        `📦 **${title}**`,
        '',
        body,
        '',
        `[Open task](/tasks/${encodeURIComponent(taskId)}) · Status: ${status}`,
      ].join('\n'),
      agentName: 'Shiba Task System',
      createdAt: new Date().toISOString(),
    });
    if (!saved) throw new Error('Originating chat session no longer exists');
    finishOutbox(item.id, { delivered: true });
    return;
  }
  throw new Error(`Unsupported task delivery target: ${item.target}`);
}

export function processTaskOutbox(limit = 20): Promise<number> {
  if (g.__shibaTaskDeliveryPromise) return g.__shibaTaskDeliveryPromise;
  const run = (async () => {
    const claimed = claimOutbox(limit);
    let delivered = 0;
    for (const item of claimed) {
      try {
        await deliverOne(item);
        delivered += 1;
      } catch (error) {
        const attempts = item.attempts;
        const delayMs = Math.min(15 * 60_000, Math.max(5_000, 2 ** Math.min(attempts, 8) * 1_000));
        finishOutbox(item.id, {
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
          retryAt: new Date(Date.now() + delayMs).toISOString(),
        });
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
  if (g.__shibaTaskDeliveryTimer) return;
  void processTaskOutbox().catch((error) => {
    console.error('[task-delivery] initial outbox pump failed', error);
  });
  g.__shibaTaskDeliveryTimer = setInterval(() => {
    void processTaskOutbox().catch((error) => {
      console.error('[task-delivery] outbox pump failed', error);
    });
  }, 2_000);
}

export function stopTaskDeliveryPump(): void {
  if (!g.__shibaTaskDeliveryTimer) return;
  clearInterval(g.__shibaTaskDeliveryTimer);
  g.__shibaTaskDeliveryTimer = undefined;
}
