import type { IntegrationCreds } from './types';

export const REDDIT_OVERRIDE_PAIR_ERROR =
  'Reddit Devvit overrides require both the external endpoint and managed app token, or neither to use the global connection.';

/**
 * A Devvit endpoint and managed token identify one app installation. Treat
 * them as an inseparable pair so an agent can never combine a scoped half with
 * the global integration (or save an override that cannot authenticate).
 */
export function redditOverridePairError(
  overrides: IntegrationCreds | null | undefined,
): string | null {
  const reddit = overrides?.reddit;
  if (!reddit) return null;
  const hasEndpoint = typeof reddit.devvitEndpoint === 'string' && reddit.devvitEndpoint.trim().length > 0;
  const hasToken = typeof reddit.devvitAppToken === 'string' && reddit.devvitAppToken.trim().length > 0;
  return hasEndpoint === hasToken ? null : REDDIT_OVERRIDE_PAIR_ERROR;
}
