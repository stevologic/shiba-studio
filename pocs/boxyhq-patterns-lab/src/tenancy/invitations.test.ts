import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvitationService, isEmailAllowedForTeam } from './invitations.ts';
import type { Team } from '../types.ts';

const openTeam: Team = {
  id: 't1',
  name: 'Open',
  slug: 'open',
  allowedDomains: [],
  billingId: null,
};

const lockedTeam: Team = {
  id: 't2',
  name: 'Corp',
  slug: 'corp',
  allowedDomains: ['corp.io', 'corp.com'],
  billingId: null,
};

describe('invitations / allowedDomains', () => {
  it('open team allows any domain', () => {
    assert.equal(isEmailAllowedForTeam(openTeam, 'x@gmail.com').allowed, true);
  });

  it('locked team rejects foreign domains', () => {
    const d = isEmailAllowedForTeam(lockedTeam, 'x@gmail.com');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'domain_not_allowed');
    assert.equal(isEmailAllowedForTeam(lockedTeam, 'a@corp.io').allowed, true);
  });

  it('service creates and accepts invites', () => {
    const svc = new InvitationService();
    const denied = svc.create(lockedTeam, 'nope@x.com', 'MEMBER');
    assert.equal(denied.decision.allowed, false);

    const ok = svc.create(lockedTeam, 'hire@corp.com', 'ADMIN');
    assert.equal(ok.decision.allowed, true);
    assert.ok(ok.invite);

    const ownerInvite = svc.create(lockedTeam, 'boss@corp.com', 'OWNER');
    assert.equal(ownerInvite.decision.allowed, false);

    const accepted = svc.accept(ok.invite!.id);
    assert.ok(accepted?.acceptedAt);
    assert.equal(svc.accept(ok.invite!.id), null);
  });
});
