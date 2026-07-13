/** Public surface for the lab — import from here in experiments. */

export { TeamConsole } from './app/team-console.ts';
export { createConfig, parseEnvFlags, isPaymentsLive } from './config/feature-flags.ts';
export { can, listPermissions, describeMatrix } from './policy/rbac.ts';
export { authorize, recordSuccess } from './policy/authorize.ts';
export { LoginLockout } from './security/login-lockout.ts';
export { TeamApiKeyVault } from './security/team-api-keys.ts';
export { AuditLog } from './observability/audit-log.ts';
export { WebhookOutbox } from './observability/webhook-outbox.ts';
export { InvitationService, isEmailAllowedForTeam } from './tenancy/invitations.ts';
export type * from './types.ts';
