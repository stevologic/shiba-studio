import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../config/feature-flags.ts';
import { TeamConsole } from './team-console.ts';

function seeded(consoleApp: TeamConsole) {
  const team = {
    id: 'team_demo',
    name: 'Demo',
    slug: 'demo',
    allowedDomains: ['demo.io'],
    billingId: null,
  };
  const owner = {
    userId: 'owner',
    teamId: team.id,
    role: 'OWNER' as const,
    email: 'o@demo.io',
  };
  const member = {
    userId: 'member',
    teamId: team.id,
    role: 'MEMBER' as const,
    email: 'm@demo.io',
  };
  consoleApp.seedTeam(team, owner);
  consoleApp.addMember(member);
  return {
    team,
    ownerCtx: consoleApp.context(team.id, owner.userId)!,
    memberCtx: consoleApp.context(team.id, member.userId)!,
  };
}

describe('TeamConsole integration', () => {
  it('end-to-end: invite, api key, audit trail', () => {
    const app = new TeamConsole({
      config: createConfig({
        stripeSecretKey: 'sk_test',
        stripeWebhookSecret: 'whsec',
      }),
    });
    const { ownerCtx, memberCtx } = seeded(app);

    const reject = app.invite(ownerCtx, 'x@gmail.com', 'MEMBER');
    assert.equal(reject.decision.allowed, false);

    const invite = app.invite(ownerCtx, 'new@demo.io', 'ADMIN');
    assert.equal(invite.decision.allowed, true);

    const memberKey = app.createApiKey(memberCtx, 'nope');
    assert.equal(memberKey.decision.allowed, false);

    const key = app.createApiKey(ownerCtx, 'ci');
    assert.equal(key.decision.allowed, true);
    assert.ok(key.secret);
    assert.equal(app.authenticateApiKey(key.secret!).allowed, true);

    const sso = app.configureSso(ownerCtx);
    assert.equal(sso.allowed, true);

    const bill = app.openBillingPortal(ownerCtx);
    assert.equal(bill.allowed, true);

    const audits = app.audit.list('team_demo');
    assert.ok(audits.some((e) => e.outcome === 'denied'));
    assert.ok(audits.some((e) => e.outcome === 'success' && e.action === 'api_key.create'));
    assert.ok(app.webhooks.pending('team_demo').length >= 1);
    assert.ok(app.webhooks.flush('team_demo') >= 1);
  });

  it('login lockout via console', () => {
    const app = new TeamConsole();
    for (let i = 0; i < 4; i++) {
      app.attemptLogin('lock@test.com', false);
    }
    const fifth = app.attemptLogin('lock@test.com', false);
    assert.equal(fifth.reason, 'account_locked');
    // even correct password while locked
    const locked = app.attemptLogin('lock@test.com', true);
    assert.equal(locked.allowed, false);
  });
});
