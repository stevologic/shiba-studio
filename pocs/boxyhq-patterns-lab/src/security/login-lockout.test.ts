import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLockout } from './login-lockout.ts';

describe('LoginLockout', () => {
  it('locks after max failures and unlocks after window', () => {
    let now = 1_000_000;
    const lock = new LoginLockout({
      maxAttempts: 3,
      lockDurationMs: 10_000,
      now: () => now,
    });

    assert.equal(lock.recordFailure('A@B.com'), false);
    assert.equal(lock.recordFailure('a@b.com'), false);
    assert.equal(lock.recordFailure('a@b.com'), true);
    assert.equal(lock.isLocked('a@b.com'), true);
    assert.equal(lock.remainingLockMs('a@b.com'), 10_000);

    now += 10_001;
    assert.equal(lock.isLocked('a@b.com'), false);
    assert.equal(lock.snapshot('a@b.com').failedCount, 0);
  });

  it('success resets counter', () => {
    const lock = new LoginLockout({ maxAttempts: 3 });
    lock.recordFailure('u@x.com');
    lock.recordFailure('u@x.com');
    lock.recordSuccess('u@x.com');
    assert.equal(lock.snapshot('u@x.com').failedCount, 0);
    assert.equal(lock.isLocked('u@x.com'), false);
  });
});
