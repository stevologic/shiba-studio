import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamApiKeyVault } from './team-api-keys.ts';

describe('TeamApiKeyVault', () => {
  it('issues secret once, stores only hash, verifies timing-safe', () => {
    const vault = new TeamApiKeyVault();
    const { record, secret } = vault.issue('team_1', 'bot');

    assert.ok(secret.startsWith('ssk_'));
    assert.equal(record.hash.length, 64);
    assert.notEqual(record.hash, secret);

    const ok = vault.verify(secret);
    assert.ok(ok);
    assert.equal(ok!.id, record.id);
    assert.equal(ok!.teamId, 'team_1');

    assert.equal(vault.verify('ssk_wrong'), null);
  });

  it('revoked keys fail verification', () => {
    const vault = new TeamApiKeyVault();
    const { record, secret } = vault.issue('team_1', 'tmp');
    assert.equal(vault.revoke(record.id), true);
    assert.equal(vault.verify(secret), null);
    assert.equal(vault.revoke(record.id), false);
  });

  it('lists keys for team without secrets', () => {
    const vault = new TeamApiKeyVault();
    vault.issue('t1', 'a');
    vault.issue('t2', 'b');
    assert.equal(vault.listForTeam('t1').length, 1);
    assert.equal(vault.listForTeam('t1')[0]!.name, 'a');
  });
});
