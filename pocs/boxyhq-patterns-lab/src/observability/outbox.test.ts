import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from './audit-log.ts';
import { WebhookOutbox } from './webhook-outbox.ts';

describe('audit + webhook stores', () => {
  it('audit filters by team', () => {
    const log = new AuditLog();
    log.append({
      teamId: 'a',
      actorUserId: 'u',
      action: 'x',
      resource: 'team',
      outcome: 'success',
    });
    log.append({
      teamId: 'b',
      actorUserId: null,
      action: 'y',
      resource: 'team',
      outcome: 'error',
    });
    assert.equal(log.list('a').length, 1);
    assert.equal(log.list().length, 2);
  });

  it('webhook outbox flush marks delivered', () => {
    const box = new WebhookOutbox();
    box.enqueue('t1', 'member.added', { id: 1 });
    box.enqueue('t2', 'member.added', { id: 2 });
    assert.equal(box.pending().length, 2);
    assert.equal(box.flush('t1'), 1);
    assert.equal(box.pending().length, 1);
    assert.equal(box.all().filter((e) => e.delivered).length, 1);
  });
});
