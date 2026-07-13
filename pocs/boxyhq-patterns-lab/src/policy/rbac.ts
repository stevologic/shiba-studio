/**
 * Team RBAC matrix — inspired by BoxyHQ lib/permissions + lib/rbac.
 * Pure data + lookup; no I/O.
 */

import type { Action, Resource, TeamRole } from '../types.ts';

type PermissionSet = ReadonlySet<`${Resource}:${Action}`>;

function perms(...entries: Array<`${Resource}:${Action}`>): PermissionSet {
  return new Set(entries);
}

/** Wildcard manage implies full CRUD on that resource. */
function expand(rolePerms: PermissionSet): PermissionSet {
  const out = new Set(rolePerms);
  for (const key of rolePerms) {
    const [resource, action] = key.split(':') as [Resource, Action];
    if (action === 'manage') {
      for (const a of ['create', 'read', 'update', 'delete'] as Action[]) {
        out.add(`${resource}:${a}`);
      }
    }
  }
  return out;
}

const MEMBER = expand(
  perms(
    'team:read',
    'team_member:read',
    'team_invitation:read',
    'team_audit_log:read',
    'team_webhook:read',
    'team_api_key:read',
    'team_billing:read',
    'team_payments:read',
  ),
);

const ADMIN = expand(
  perms(
    ...MEMBER,
    'team:update',
    'team_member:create',
    'team_member:update',
    'team_member:delete',
    'team_invitation:manage',
    'team_sso:manage',
    'team_dsync:manage',
    'team_audit_log:read',
    'team_webhook:manage',
    'team_api_key:manage',
    'team_payments:read',
    'team_billing:read',
  ),
);

const OWNER = expand(
  perms(
    ...ADMIN,
    'team:delete',
    'team:manage',
    'team_member:manage',
    'team_billing:manage',
    'team_payments:manage',
  ),
);

const MATRIX: Record<TeamRole, PermissionSet> = {
  OWNER,
  ADMIN,
  MEMBER,
};

export function can(role: TeamRole, resource: Resource, action: Action): boolean {
  return MATRIX[role].has(`${resource}:${action}`);
}

export function listPermissions(role: TeamRole): string[] {
  return [...MATRIX[role]].sort();
}

/** Human-readable dump used by demo + docs. */
export function describeMatrix(): Record<TeamRole, string[]> {
  return {
    OWNER: listPermissions('OWNER'),
    ADMIN: listPermissions('ADMIN'),
    MEMBER: listPermissions('MEMBER'),
  };
}
