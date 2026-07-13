import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConfig,
  isFeatureEnabled,
  isPaymentsLive,
  parseEnvFlags,
  featureFlagForResource,
} from './feature-flags.ts';

describe('feature flags', () => {
  it('defaults all enterprise modules on', () => {
    const c = createConfig();
    assert.equal(isFeatureEnabled(c, 'FEATURE_TEAM_SSO'), true);
    assert.equal(isFeatureEnabled(c, 'FEATURE_TEAM_WEBHOOK'), true);
  });

  it('payments live requires flag + both Stripe secrets', () => {
    assert.equal(isPaymentsLive(createConfig()), false);
    assert.equal(
      isPaymentsLive(
        createConfig({
          stripeSecretKey: 'sk_test',
          stripeWebhookSecret: null,
        }),
      ),
      false,
    );
    assert.equal(
      isPaymentsLive(
        createConfig({
          stripeSecretKey: 'sk_test',
          stripeWebhookSecret: 'whsec_test',
        }),
      ),
      true,
    );
    assert.equal(
      isPaymentsLive(
        createConfig({
          flags: { FEATURE_TEAM_PAYMENTS: false },
          stripeSecretKey: 'sk_test',
          stripeWebhookSecret: 'whsec_test',
        }),
      ),
      false,
    );
  });

  it('maps resources to flags', () => {
    assert.equal(featureFlagForResource('team_sso'), 'FEATURE_TEAM_SSO');
    assert.equal(featureFlagForResource('team_member'), null);
  });

  it('parseEnvFlags respects off values', () => {
    const c = parseEnvFlags({
      FEATURE_TEAM_SSO: 'false',
      FEATURE_TEAM_API_KEY: '0',
      STRIPE_SECRET_KEY: 'sk',
      STRIPE_WEBHOOK_SECRET: 'wh',
    } as NodeJS.ProcessEnv);
    assert.equal(c.flags.FEATURE_TEAM_SSO, false);
    assert.equal(c.flags.FEATURE_TEAM_API_KEY, false);
    assert.equal(isPaymentsLive(c), true);
  });
});
