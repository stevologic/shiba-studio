/**
 * In-memory audit log — Retraced-shaped events without the SaaS dependency.
 */

import { randomBytes } from 'node:crypto';
import type { AuditEvent } from '../types.ts';

export class AuditLog {
  private readonly events: AuditEvent[] = [];

  append(
    input: Omit<AuditEvent, 'id' | 'ts'> & { ts?: string; id?: string },
  ): AuditEvent {
    const event: AuditEvent = {
      id: input.id ?? `aud_${randomBytes(6).toString('hex')}`,
      ts: input.ts ?? new Date().toISOString(),
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: input.action,
      resource: input.resource,
      outcome: input.outcome,
      meta: input.meta,
    };
    this.events.push(event);
    return event;
  }

  list(teamId?: string): AuditEvent[] {
    const all = teamId
      ? this.events.filter((e) => e.teamId === teamId)
      : [...this.events];
    return all.map((e) => ({ ...e, meta: e.meta ? { ...e.meta } : undefined }));
  }

  clear(): void {
    this.events.length = 0;
  }
}
