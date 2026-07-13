import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../config/feature-flags.ts';
import { AuditLog } from '../observability/audit-log.ts';
import { WebhookOutbox } from '../observability/webhook-outbox.ts';
import { authorize } from './authorize.ts';
import type { AuthContext } from '../types.ts';

function ctx(role: AuthContext['member']['role']): AuthContext {
  return {
    team: {
      id: 'team_x',
      name: 'X',
      slug: 'x',
      allowedDomains: [],
      billingId: 'cus_1',
    },
    member: {
      userId: 'u1',
      teamId: 'team_x',
      role,
      email: 'u1@x.com',
    },
  };
}

describe('authorize + audit-on-deny', () => {
  it('denies MEMBER manage SSO and audits + webhooks', () => {
    const audit = new AuditLog();
    const webhooks = new WebhookOutbox();
    const decision = authorize(
      { config: createConfig(), audit, webhooks },
      { ctx: ctx('MEMBER'), resource: 'team_sso', action: 'manage' },
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'role_denied');
    const events = audit.list('team_x');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, 'denied');
    assert.equal(webhooks.pending('team_x').length, 1);
    assert.equal(webhooks.pending('team_x')[0]!.type, 'security.authorization_denied');
  });

  it('denies when feature flag is off', () => {
    const audit = new AuditLog();
    const decision = authorize(
      {
        config: createConfig({ flags: { FEATURE_TEAM_SSO: false } }),
        audit,
      },
      { ctx: ctx('OWNER'), resource: 'team_sso', action: 'manage' },
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'feature_disabled');
  });

  it('denies billing manage without Stripe secrets', () => {
    const audit = new AuditLog();
    const decision = authorize(
      { config: createConfig({ flags: { FEATURE_TEAM_PAYMENTS: true } }), audit },
      { ctx: ctx('OWNER'), resource: 'team_billing', action: 'manage' },
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'payments_not_configured');
  });

  it('allows OWNER billing manage when Stripe is live', () => {
    const audit = new AuditLog();
    const decision = authorize(
      {
        config: createConfig({
          stripeSecretKey: 'sk',
          stripeWebhookSecret: 'wh',
        }),
        audit,
      },
      { ctx: ctx('OWNER'), resource: 'team_billing', action: 'manage' },
    );
    assert.equal(decision.allowed, true);
    assert.equal(audit.list().length, 0);
  });
});
