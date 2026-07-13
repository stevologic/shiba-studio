/**
 * Thin façade that ties patterns into team operations.
 * This is the "sample product surface" of the lab.
 */

import { createConfig, type RuntimeConfig } from '../config/feature-flags.ts';
import { AuditLog } from '../observability/audit-log.ts';
import { WebhookOutbox } from '../observability/webhook-outbox.ts';
import { authorize, recordSuccess, type AuthorizeDeps } from '../policy/authorize.ts';
import { LoginLockout } from '../security/login-lockout.ts';
import { TeamApiKeyVault } from '../security/team-api-keys.ts';
import { InvitationService } from '../tenancy/invitations.ts';
import type {
  Action,
  AuthContext,
  Decision,
  Resource,
  Team,
  TeamMember,
  TeamRole,
} from '../types.ts';

export interface TeamConsoleOptions {
  config?: RuntimeConfig;
}

export class TeamConsole {
  readonly config: RuntimeConfig;
  readonly audit = new AuditLog();
  readonly webhooks = new WebhookOutbox();
  readonly lockout = new LoginLockout({ maxAttempts: 5, lockDurationMs: 15 * 60 * 1000 });
  readonly apiKeys = new TeamApiKeyVault();
  readonly invitations = new InvitationService();

  private readonly teams = new Map<string, Team>();
  private readonly members = new Map<string, TeamMember>(); // key: teamId:userId

  constructor(opts: TeamConsoleOptions = {}) {
    this.config = opts.config ?? createConfig();
  }

  private deps(): AuthorizeDeps {
    return {
      config: this.config,
      audit: this.audit,
      webhooks: this.webhooks,
    };
  }

  seedTeam(team: Team, owner: TeamMember): void {
    this.teams.set(team.id, team);
    this.members.set(`${team.id}:${owner.userId}`, owner);
  }

  addMember(member: TeamMember): void {
    this.members.set(`${member.teamId}:${member.userId}`, member);
  }

  getTeam(teamId: string): Team | undefined {
    const t = this.teams.get(teamId);
    return t ? { ...t, allowedDomains: [...t.allowedDomains] } : undefined;
  }

  context(teamId: string, userId: string): AuthContext | null {
    const team = this.teams.get(teamId);
    const member = this.members.get(`${teamId}:${userId}`);
    if (!team || !member) return null;
    return {
      team: { ...team, allowedDomains: [...team.allowedDomains] },
      member: { ...member },
    };
  }

  attemptLogin(email: string, passwordOk: boolean): Decision {
    if (this.lockout.isLocked(email)) {
      return {
        allowed: false,
        reason: 'account_locked',
        detail: `locked for ${this.lockout.remainingLockMs(email)}ms`,
      };
    }
    if (!passwordOk) {
      const locked = this.lockout.recordFailure(email);
      return {
        allowed: false,
        reason: locked ? 'account_locked' : 'invalid_credentials',
        detail: locked ? 'max attempts exceeded' : 'invalid credentials',
      };
    }
    this.lockout.recordSuccess(email);
    return { allowed: true };
  }

  guard(ctx: AuthContext, resource: Resource, action: Action, op?: string): Decision {
    return authorize(this.deps(), { ctx, resource, action, op });
  }

  invite(
    ctx: AuthContext,
    email: string,
    role: TeamRole,
  ): { decision: Decision; inviteId?: string } {
    const gate = this.guard(ctx, 'team_invitation', 'create', 'invitation.create');
    if (!gate.allowed) return { decision: gate };

    const { invite, decision } = this.invitations.create(ctx.team, email, role);
    if (!decision.allowed) {
      this.audit.append({
        teamId: ctx.team.id,
        actorUserId: ctx.member.userId,
        action: 'invitation.create',
        resource: 'team_invitation',
        outcome: 'denied',
        meta: { reason: decision.reason, email },
      });
      return { decision };
    }

    recordSuccess(this.deps(), ctx, 'invitation.create', 'team_invitation', {
      email,
      role,
      inviteId: invite!.id,
    });
    return { decision: { allowed: true }, inviteId: invite!.id };
  }

  createApiKey(
    ctx: AuthContext,
    name: string,
  ): { decision: Decision; secret?: string; keyId?: string } {
    const gate = this.guard(ctx, 'team_api_key', 'create', 'api_key.create');
    if (!gate.allowed) return { decision: gate };

    const issued = this.apiKeys.issue(ctx.team.id, name);
    recordSuccess(this.deps(), ctx, 'api_key.create', 'team_api_key', {
      keyId: issued.record.id,
      prefix: issued.record.prefix,
    });
    return {
      decision: { allowed: true },
      secret: issued.secret,
      keyId: issued.record.id,
    };
  }

  authenticateApiKey(secret: string): Decision & { teamId?: string; keyId?: string } {
    const rec = this.apiKeys.verify(secret);
    if (!rec) {
      return { allowed: false, reason: 'invalid_api_key' };
    }
    return { allowed: true, teamId: rec.teamId, keyId: rec.id };
  }

  openBillingPortal(ctx: AuthContext): Decision {
    const gate = this.guard(ctx, 'team_billing', 'manage', 'billing.portal');
    if (!gate.allowed) return gate;
    recordSuccess(this.deps(), ctx, 'billing.portal', 'team_billing', {
      billingId: ctx.team.billingId,
    });
    return { allowed: true };
  }

  configureSso(ctx: AuthContext): Decision {
    const gate = this.guard(ctx, 'team_sso', 'manage', 'sso.configure');
    if (!gate.allowed) return gate;
    recordSuccess(this.deps(), ctx, 'sso.configure', 'team_sso');
    return { allowed: true };
  }
}
