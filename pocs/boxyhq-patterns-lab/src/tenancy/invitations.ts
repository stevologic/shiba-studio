/**
 * Team invitations with allowedDomains gate.
 * BoxyHQ multi-domain invite control pattern.
 */

import { randomBytes } from 'node:crypto';
import type { Decision, Team, TeamRole } from '../types.ts';

export interface Invitation {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  createdAt: string;
  acceptedAt: string | null;
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Empty allowedDomains = open invites (any domain).
 * Otherwise invitee email domain must match one of the allowlisted domains.
 */
export function isEmailAllowedForTeam(team: Team, email: string): Decision {
  const domain = emailDomain(email);
  if (!domain) {
    return { allowed: false, reason: 'domain_not_allowed', detail: 'invalid email' };
  }
  if (!team.allowedDomains.length) {
    return { allowed: true };
  }
  const allowed = team.allowedDomains.map((d) => d.toLowerCase());
  if (allowed.includes(domain)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'domain_not_allowed',
    detail: `domain ${domain} not in allowedDomains [${allowed.join(', ')}]`,
  };
}

export class InvitationService {
  private readonly invites = new Map<string, Invitation>();

  create(team: Team, email: string, role: TeamRole): { invite?: Invitation; decision: Decision } {
    const decision = isEmailAllowedForTeam(team, email);
    if (!decision.allowed) {
      return { decision };
    }
    if (role === 'OWNER') {
      return {
        decision: {
          allowed: false,
          reason: 'role_denied',
          detail: 'cannot invite as OWNER',
        },
      };
    }
    const invite: Invitation = {
      id: `inv_${randomBytes(6).toString('hex')}`,
      teamId: team.id,
      email: email.trim().toLowerCase(),
      role,
      createdAt: new Date().toISOString(),
      acceptedAt: null,
    };
    this.invites.set(invite.id, invite);
    return { invite, decision: { allowed: true } };
  }

  accept(inviteId: string): Invitation | null {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.acceptedAt) return null;
    inv.acceptedAt = new Date().toISOString();
    return { ...inv };
  }

  listForTeam(teamId: string): Invitation[] {
    return [...this.invites.values()]
      .filter((i) => i.teamId === teamId)
      .map((i) => ({ ...i }));
  }
}
