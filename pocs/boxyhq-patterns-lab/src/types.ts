/** Shared domain types for the BoxyHQ patterns lab. */

export type TeamRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Resources a team member may act on (BoxyHQ-style matrix). */
export type Resource =
  | 'team'
  | 'team_member'
  | 'team_invitation'
  | 'team_sso'
  | 'team_dsync'
  | 'team_audit_log'
  | 'team_webhook'
  | 'team_api_key'
  | 'team_payments'
  | 'team_billing';

export type Action = 'create' | 'read' | 'update' | 'delete' | 'manage';

export type FeatureFlag =
  | 'FEATURE_TEAM_SSO'
  | 'FEATURE_TEAM_DSYNC'
  | 'FEATURE_TEAM_AUDIT_LOG'
  | 'FEATURE_TEAM_WEBHOOK'
  | 'FEATURE_TEAM_API_KEY'
  | 'FEATURE_TEAM_PAYMENTS'
  | 'FEATURE_TEAM_DELETION';

export interface TeamMember {
  userId: string;
  teamId: string;
  role: TeamRole;
  email: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  /** Domains that may receive invitations (empty = any domain). */
  allowedDomains: string[];
  /** Stripe customer id when billing is linked. */
  billingId: string | null;
}

export interface AuthContext {
  member: TeamMember;
  team: Team;
}

export type DenyReason =
  | 'role_denied'
  | 'feature_disabled'
  | 'payments_not_configured'
  | 'domain_not_allowed'
  | 'account_locked'
  | 'invalid_credentials'
  | 'invalid_api_key'
  | 'not_found';

export interface Decision {
  allowed: boolean;
  reason?: DenyReason;
  detail?: string;
}

export interface AuditEvent {
  id: string;
  ts: string;
  teamId: string;
  actorUserId: string | null;
  action: string;
  resource: string;
  outcome: 'success' | 'denied' | 'error';
  meta?: Record<string, unknown>;
}

export interface WebhookEnvelope {
  id: string;
  ts: string;
  teamId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  delivered: boolean;
}
