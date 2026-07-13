/**
 * CLI walkthrough of enterprise patterns.
 * Run: npm run demo
 */

import { createConfig } from './config/feature-flags.ts';
import { TeamConsole } from './app/team-console.ts';
import { describeMatrix } from './policy/rbac.ts';

function line(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
}

function main(): void {
  console.log('BoxyHQ patterns lab — demo (SHIB-14 original POC)\n');

  const consoleApp = new TeamConsole({
    config: createConfig({
      // Payments flag on but Stripe missing → billing manage should deny
      stripeSecretKey: null,
      stripeWebhookSecret: null,
    }),
  });

  const team = {
    id: 'team_acme',
    name: 'Acme Corp',
    slug: 'acme',
    allowedDomains: ['acme.com'],
    billingId: null,
  };

  const owner = {
    userId: 'user_owner',
    teamId: team.id,
    role: 'OWNER' as const,
    email: 'ceo@acme.com',
  };
  const member = {
    userId: 'user_member',
    teamId: team.id,
    role: 'MEMBER' as const,
    email: 'dev@acme.com',
  };

  consoleApp.seedTeam(team, owner);
  consoleApp.addMember(member);

  line('RBAC matrix sizes');
  const matrix = describeMatrix();
  for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
    console.log(`  ${role}: ${matrix[role].length} permissions`);
  }

  line('Login lockout');
  for (let i = 1; i <= 5; i++) {
    const r = consoleApp.attemptLogin('attacker@evil.test', false);
    console.log(`  attempt ${i}: allowed=${r.allowed} reason=${r.reason}`);
  }

  const ownerCtx = consoleApp.context(team.id, owner.userId)!;
  const memberCtx = consoleApp.context(team.id, member.userId)!;

  line('Invitation allowedDomains');
  const bad = consoleApp.invite(ownerCtx, 'outsider@gmail.com', 'MEMBER');
  console.log(`  gmail invite: allowed=${bad.decision.allowed} (${bad.decision.reason})`);
  const good = consoleApp.invite(ownerCtx, 'hire@acme.com', 'ADMIN');
  console.log(`  acme invite: allowed=${good.decision.allowed} id=${good.inviteId}`);

  line('Member cannot manage SSO');
  const ssoMember = consoleApp.configureSso(memberCtx);
  console.log(`  member SSO: allowed=${ssoMember.allowed} (${ssoMember.reason})`);

  line('Owner SSO (feature on)');
  const ssoOwner = consoleApp.configureSso(ownerCtx);
  console.log(`  owner SSO: allowed=${ssoOwner.allowed}`);

  line('API key issue + verify');
  const key = consoleApp.createApiKey(ownerCtx, 'ci-bot');
  console.log(`  issued: keyId=${key.keyId} secretPrefix=${key.secret?.slice(0, 12)}…`);
  const auth = consoleApp.authenticateApiKey(key.secret!);
  console.log(`  verify: allowed=${auth.allowed} teamId=${auth.teamId}`);
  const bogus = consoleApp.authenticateApiKey('ssk_not_a_real_key');
  console.log(`  bogus: allowed=${bogus.allowed} (${bogus.reason})`);

  line('Billing gated on Stripe secrets');
  const bill = consoleApp.openBillingPortal(ownerCtx);
  console.log(`  billing portal: allowed=${bill.allowed} (${bill.reason})`);

  line('Audit + webhook outbox');
  const audits = consoleApp.audit.list(team.id);
  console.log(`  audit events: ${audits.length}`);
  for (const e of audits.slice(-5)) {
    console.log(`    [${e.outcome}] ${e.action} — ${JSON.stringify(e.meta?.reason ?? '')}`);
  }
  const pending = consoleApp.webhooks.pending(team.id);
  console.log(`  webhook pending: ${pending.length}`);
  const flushed = consoleApp.webhooks.flush(team.id);
  console.log(`  flushed: ${flushed}`);

  console.log('\nDone. Patterns ready to cherry-pick — not a BoxyHQ fork.\n');
}

main();
