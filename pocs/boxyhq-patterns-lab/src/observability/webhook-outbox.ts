/**
 * Outbound webhook outbox — Svix-shaped emit without the network.
 * Events sit in a durable-ish queue until "delivered" (demo flushes).
 */

import { randomBytes } from 'node:crypto';
import type { WebhookEnvelope } from '../types.ts';

export class WebhookOutbox {
  private readonly queue: WebhookEnvelope[] = [];

  enqueue(
    teamId: string,
    type: string,
    payload: Record<string, unknown>,
  ): WebhookEnvelope {
    const env: WebhookEnvelope = {
      id: `wh_${randomBytes(6).toString('hex')}`,
      ts: new Date().toISOString(),
      teamId,
      type,
      payload: { ...payload },
      attempts: 0,
      delivered: false,
    };
    this.queue.push(env);
    return { ...env, payload: { ...env.payload } };
  }

  pending(teamId?: string): WebhookEnvelope[] {
    return this.queue
      .filter((e) => !e.delivered && (teamId ? e.teamId === teamId : true))
      .map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  /**
   * Simulate delivery: bump attempts, mark delivered.
   * Returns number flushed.
   */
  flush(teamId?: string): number {
    let n = 0;
    for (const env of this.queue) {
      if (env.delivered) continue;
      if (teamId && env.teamId !== teamId) continue;
      env.attempts += 1;
      env.delivered = true;
      n += 1;
    }
    return n;
  }

  all(): WebhookEnvelope[] {
    return this.queue.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  clear(): void {
    this.queue.length = 0;
  }
}
