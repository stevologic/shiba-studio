/**
 * Env-style feature flags for team enterprise modules.
 * Mirrors BoxyHQ FEATURE_TEAM_* toggles; payments also require Stripe secrets.
 */

import type { FeatureFlag, Resource } from '../types.ts';

export interface RuntimeConfig {
  flags: Record<FeatureFlag, boolean>;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
}

const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  FEATURE_TEAM_SSO: true,
  FEATURE_TEAM_DSYNC: true,
  FEATURE_TEAM_AUDIT_LOG: true,
  FEATURE_TEAM_WEBHOOK: true,
  FEATURE_TEAM_API_KEY: true,
  FEATURE_TEAM_PAYMENTS: true,
  FEATURE_TEAM_DELETION: true,
};

/** Map resources that are gated by a feature flag. */
const RESOURCE_FLAG: Partial<Record<Resource, FeatureFlag>> = {
  team_sso: 'FEATURE_TEAM_SSO',
  team_dsync: 'FEATURE_TEAM_DSYNC',
  team_audit_log: 'FEATURE_TEAM_AUDIT_LOG',
  team_webhook: 'FEATURE_TEAM_WEBHOOK',
  team_api_key: 'FEATURE_TEAM_API_KEY',
  team_payments: 'FEATURE_TEAM_PAYMENTS',
  team_billing: 'FEATURE_TEAM_PAYMENTS',
};

export function createConfig(overrides?: {
  flags?: Partial<Record<FeatureFlag, boolean>>;
  stripeSecretKey?: string | null;
  stripeWebhookSecret?: string | null;
}): RuntimeConfig {
  return {
    flags: { ...DEFAULT_FLAGS, ...overrides?.flags },
    stripeSecretKey: overrides?.stripeSecretKey ?? null,
    stripeWebhookSecret: overrides?.stripeWebhookSecret ?? null,
  };
}

export function isFeatureEnabled(config: RuntimeConfig, flag: FeatureFlag): boolean {
  return Boolean(config.flags[flag]);
}

export function paymentsConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.stripeSecretKey && config.stripeWebhookSecret);
}

/**
 * Payments are enabled only when the feature flag is on AND Stripe secrets exist
 * (BoxyHQ enables payments only when STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are set).
 */
export function isPaymentsLive(config: RuntimeConfig): boolean {
  return isFeatureEnabled(config, 'FEATURE_TEAM_PAYMENTS') && paymentsConfigured(config);
}

export function featureFlagForResource(resource: Resource): FeatureFlag | null {
  return RESOURCE_FLAG[resource] ?? null;
}

export function parseEnvFlags(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const bool = (key: FeatureFlag, fallback: boolean): boolean => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
  };

  return createConfig({
    flags: {
      FEATURE_TEAM_SSO: bool('FEATURE_TEAM_SSO', true),
      FEATURE_TEAM_DSYNC: bool('FEATURE_TEAM_DSYNC', true),
      FEATURE_TEAM_AUDIT_LOG: bool('FEATURE_TEAM_AUDIT_LOG', true),
      FEATURE_TEAM_WEBHOOK: bool('FEATURE_TEAM_WEBHOOK', true),
      FEATURE_TEAM_API_KEY: bool('FEATURE_TEAM_API_KEY', true),
      FEATURE_TEAM_PAYMENTS: bool('FEATURE_TEAM_PAYMENTS', true),
      FEATURE_TEAM_DELETION: bool('FEATURE_TEAM_DELETION', true),
    },
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
  });
}
