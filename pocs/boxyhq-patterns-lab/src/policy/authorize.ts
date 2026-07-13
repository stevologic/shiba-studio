/**
 * Unified authorize: role matrix + feature flags + payments gate.
 * Denies are written to the audit log (audit-on-deny).
 */

import {
  featureFlagForResource,
  isFeatureEnabled,
  isPaymentsLive,
  type RuntimeConfig,
} from '../config/feature-flags.ts';
import type { AuditLog } from '../observability/audit-log.ts';
import type { WebhookOutbox } from '../observability/webhook-outbox.ts';
import type {
  Action,
  AuthContext,
  Decision,
  Resource,
} from '../types.ts';
import { can } from './rbac.ts';

export interface AuthorizeDeps {
  config: RuntimeConfig;
  audit: AuditLog;
  webhooks?: WebhookOutbox;
}

export interface AuthorizeInput {
  ctx: AuthContext;
  resource: Resource;
  action: Action;
  /** Extra label for audit action string. */
  op?: string;
}

export function authorize(deps: AuthorizeDeps, input: AuthorizeInput): Decision {
  const { ctx, resource, action, op } = input;
  const actionLabel = op ?? `${resource}.${action}`;

  // 1) Role matrix
  if (!can(ctx.member.role, resource, action)) {
    return deny(deps, ctx, actionLabel, resource, 'role_denied', {
      role: ctx.member.role,
      needed: `${resource}:${action}`,
    });
  }

  // 2) Feature flag for enterprise modules
  const flag = featureFlagForResource(resource);
  if (flag && !isFeatureEnabled(deps.config, flag)) {
    return deny(deps, ctx, actionLabel, resource, 'feature_disabled', { flag });
  }

  // 3) Payments: flag alone is not enough — Stripe must be configured
  if (
    (resource === 'team_payments' || resource === 'team_billing')
    && (action === 'manage' || action === 'update' || action === 'create')
  ) {
    if (!isPaymentsLive(deps.config)) {
      return deny(deps, ctx, actionLabel, resource, 'payments_not_configured', {
        flagOn: isFeatureEnabled(deps.config, 'FEATURE_TEAM_PAYMENTS'),
      });
    }
  }

  // 4) Team deletion gated by FEATURE_TEAM_DELETION
  if (resource === 'team' && action === 'delete') {
    if (!isFeatureEnabled(deps.config, 'FEATURE_TEAM_DELETION')) {
      return deny(deps, ctx, actionLabel, resource, 'feature_disabled', {
        flag: 'FEATURE_TEAM_DELETION',
      });
    }
  }

  return { allowed: true };
}

function deny(
  deps: AuthorizeDeps,
  ctx: AuthContext,
  actionLabel: string,
  resource: Resource,
  reason: Decision['reason'],
  meta?: Record<string, unknown>,
): Decision {
  const decision: Decision = {
    allowed: false,
    reason,
    detail: reason,
  };

  deps.audit.append({
    teamId: ctx.team.id,
    actorUserId: ctx.member.userId,
    action: actionLabel,
    resource,
    outcome: 'denied',
    meta: { reason, ...meta },
  });

  // Optional: emit security webhook on deny (enterprise ops pattern)
  deps.webhooks?.enqueue(ctx.team.id, 'security.authorization_denied', {
    userId: ctx.member.userId,
    action: actionLabel,
    resource,
    reason,
  });

  return decision;
}

/** Record a successful mutation in audit + webhook outbox. */
export function recordSuccess(
  deps: AuthorizeDeps,
  ctx: AuthContext,
  actionLabel: string,
  resource: Resource,
  meta?: Record<string, unknown>,
): void {
  deps.audit.append({
    teamId: ctx.team.id,
    actorUserId: ctx.member.userId,
    action: actionLabel,
    resource,
    outcome: 'success',
    meta,
  });
  deps.webhooks?.enqueue(ctx.team.id, `team.${actionLabel}`, {
    userId: ctx.member.userId,
    resource,
    ...meta,
  });
}
