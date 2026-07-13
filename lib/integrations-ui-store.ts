/**
 * Module-level integration credentials for the client shell.
 *
 * Tab navigation remounts the whole shell (one catch-all route), which reset
 * `intCreds` to empty every time — so the Capabilities cards flashed "Not set
 * up" for every configured integration until the /api/integrations fetch
 * returned. Caching here (like agents-ui-store / nav-stats-store) lets the
 * cards render their real state instantly on remount, with no flash.
 */
'use client';

export type IntegrationCredsMap = Record<string, Record<string, unknown>>;

const EMPTY: IntegrationCredsMap = {
  github: {}, slack: {}, googledrive: {}, discord: {}, x: {},
  reddit: {}, obsidian: { mode: 'local' }, vercel: {}, netlify: {}, linear: {}, jira: {},
};

let cached: IntegrationCredsMap | null = null;

/** Public, non-secret Reddit OAuth status returned by the server. */
export type RedditOAuthStatus = {
  connected: boolean;
  expired?: boolean;
  username?: string;
  userId?: string;
  scopes?: string[];
  expiresAt?: string;
  clientReady?: boolean;
  bundledClient?: boolean;
  error?: string;
};

let cachedRedditStatus: RedditOAuthStatus | null = null;

/** Last-known creds, or the empty scaffold on a cold start. */
export function getCachedIntegrationCreds(): IntegrationCredsMap {
  return cached ?? { ...EMPTY };
}

export function hasCachedIntegrationCreds(): boolean {
  return cached !== null;
}

/** Store the server's creds so the next remount seeds from them immediately. */
export function setCachedIntegrationCreds(creds: IntegrationCredsMap): void {
  cached = { ...EMPTY, ...creds };
}

/** Keep OAuth identity/status stable while the catch-all client shell remounts. */
export function getCachedRedditOAuthStatus(): RedditOAuthStatus | null {
  return cachedRedditStatus;
}

export function setCachedRedditOAuthStatus(status: RedditOAuthStatus): void {
  cachedRedditStatus = { ...status };
}
