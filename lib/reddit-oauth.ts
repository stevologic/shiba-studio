// Reddit OAuth 2.0 for the native core integration.
//
// Reddit requires a registered/approved client, an exact redirect URI, and an
// identifying User-Agent. The app credentials and captured user tokens live in
// integrations.reddit, where the persistence layer seals secret fields.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { loadConfig, updateIntegrationConfig } from './persistence';
import type { IntegrationCreds } from './types';
import { advanceOAuthGeneration, currentOAuthGeneration } from './oauth-revocation';

const REDDIT_AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_REVOKE_URL = 'https://www.reddit.com/api/v1/revoke_token';
const REDDIT_API_ORIGIN = 'https://oauth.reddit.com';
const REDDIT_SCOPES = ['identity', 'read', 'submit'] as const;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const STATE_TTL_MS = 10 * 60_000;
const NETWORK_TIMEOUT_MS = 15_000;

type RedditCreds = NonNullable<IntegrationCreds['reddit']>;

interface RedditOAuthClient {
  clientId: string;
  clientSecret: string;
}

interface RedditPendingState {
  state: string;
  redirectUri: string;
  clientId: string;
  createdAt: string;
  generation?: number;
}

interface RedditTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface RedditTokenPatch {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: string;
  scopes: string[];
}

export interface RedditOAuthStatus {
  connected: boolean;
  expired: boolean;
  clientReady: boolean;
  bundledClient: boolean;
  username?: string;
  userId?: string;
  scopes: string[];
  expiresAt?: string;
  error?: string;
}

export type RedditOAuthRequestInit = RequestInit & {
  /** Opt in only for safe/read requests. Mutating requests are never replayed. */
  retryUnauthorized?: boolean;
};

type RedditOAuthGlobals = typeof globalThis & {
  __shibaRedditPendingChain?: Promise<unknown>;
  __shibaRedditRefreshes?: Map<string, Promise<RedditTokenPatch>>;
  __shibaRedditOAuthMutationChain?: Promise<unknown>;
};

const globals = globalThis as RedditOAuthGlobals;
const refreshes = globals.__shibaRedditRefreshes
  ?? (globals.__shibaRedditRefreshes = new Map<string, Promise<RedditTokenPatch>>());

function withOAuthMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globals.__shibaRedditOAuthMutationChain ?? Promise.resolve();
  const run = previous.then(operation, operation);
  globals.__shibaRedditOAuthMutationChain = run.then(() => undefined, () => undefined);
  return run;
}

let redditOAuthDataDirOverride: string | null = null;

/** Test isolation hook, mirroring xai-oauth's data-directory override. */
export function setRedditOAuthDataDir(dir: string | null): void {
  redditOAuthDataDirOverride = dir;
  refreshes.clear();
}

function networkSignal(caller?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function pendingFile(): string {
  return path.join(redditOAuthDataDirOverride || dataDir(), 'reddit-oauth-pending.json');
}

function withPendingLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globals.__shibaRedditPendingChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  globals.__shibaRedditPendingChain = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('The Shiba Studio origin is required for Reddit sign-in');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The Shiba Studio origin for Reddit sign-in is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Reddit OAuth callbacks require an http or https Shiba Studio origin');
  }
  if (url.username || url.password) {
    throw new Error('The Shiba Studio origin must not contain credentials');
  }
  return url.origin;
}

/** Exact redirect URI to register on the approved Reddit OAuth application. */
export function redditRedirectUri(appOrigin: string): string {
  return `${normalizeOrigin(appOrigin)}/api/reddit-oauth/callback`;
}

function envRedditClient(): { clientId: string; clientSecret: string; partial: boolean } {
  const clientId = (
    process.env.REDDIT_OAUTH_CLIENT_ID
    || process.env.REDDIT_CLIENT_ID
    || ''
  ).trim();
  const clientSecret = (
    process.env.REDDIT_OAUTH_CLIENT_SECRET
    || process.env.REDDIT_CLIENT_SECRET
    || ''
  ).trim();
  return { clientId, clientSecret, partial: !!clientId !== !!clientSecret };
}

/** Optional bundled client. A user-saved pair always takes precedence. */
export function bundledRedditClient(): RedditOAuthClient | null {
  const env = envRedditClient();
  return env.clientId && env.clientSecret
    ? { clientId: env.clientId, clientSecret: env.clientSecret }
    : null;
}

function resolveRedditClient(provider: RedditCreds): RedditOAuthClient {
  const clientId = provider.clientId?.trim() || '';
  const clientSecret = provider.clientSecret?.trim() || '';

  // Never combine half of a saved pair with half of the bundled pair.
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error('The saved Reddit Client ID and Client Secret must be supplied together');
    }
    return { clientId, clientSecret };
  }

  const bundled = bundledRedditClient();
  if (bundled) return bundled;
  if (envRedditClient().partial) {
    throw new Error('REDDIT_OAUTH_CLIENT_ID and REDDIT_OAUTH_CLIENT_SECRET must be configured together');
  }
  throw new Error('No Reddit OAuth client is configured');
}

async function configuredRedditCreds(): Promise<RedditCreds> {
  const cfg = await loadConfig();
  return cfg.integrations?.reddit || {};
}

export async function isRedditClientReady(): Promise<boolean> {
  try {
    resolveRedditClient(await configuredRedditCreds());
    return true;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function writePendingUnlocked(pending: RedditPendingState): Promise<void> {
  const file = pendingFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(pending, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function clearPendingUnlocked(): Promise<void> {
  try {
    await fs.rm(pendingFile(), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

async function readPendingUnlocked(): Promise<RedditPendingState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingFile(), 'utf8')) as Partial<RedditPendingState>;
    if (!parsed.state || !parsed.redirectUri || !parsed.clientId || !parsed.createdAt) return null;
    return parsed as RedditPendingState;
  } catch {
    return null;
  }
}

/** Remove an expired or malformed one-time authorization challenge. The live
 * Reddit tokens are stored separately in config and are never touched here. */
export function pruneExpiredRedditOAuthPending(nowMs = Date.now()): Promise<boolean> {
  return withPendingLock(async () => {
    let raw: string;
    try {
      raw = await fs.readFile(pendingFile(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
    try {
      const pending = JSON.parse(raw) as Partial<RedditPendingState>;
      const age = nowMs - Date.parse(String(pending.createdAt || ''));
      if (
        pending.state
        && pending.redirectUri
        && pending.clientId
        && Number.isFinite(age)
        && age >= 0
        && age <= STATE_TTL_MS
      ) return false;
    } catch {
      // Malformed challenge files cannot represent a live flow.
    }
    await clearPendingUnlocked();
    return true;
  });
}

async function consumePendingState(
  suppliedState: string,
  redirectUri: string,
  clientId: string,
): Promise<RedditPendingState> {
  return withPendingLock(async () => {
    const pending = await readPendingUnlocked();
    if (!pending) throw new Error('Reddit sign-in expired or was already completed; start again');

    const age = Date.now() - Date.parse(pending.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) {
      await clearPendingUnlocked();
      throw new Error('Reddit sign-in expired; start again');
    }
    if (!safeEqual(pending.state, suppliedState)) {
      throw new Error('Reddit OAuth state did not match; sign-in was rejected');
    }
    if (pending.redirectUri !== redirectUri || !safeEqual(pending.clientId, clientId)) {
      throw new Error('Reddit OAuth client or callback changed during sign-in; start again');
    }

    // Delete before making the token request: a code/state pair is one-use even
    // when the network exchange subsequently fails.
    await clearPendingUnlocked();
    return pending;
  });
}

/** Begin Reddit's permanent authorization-code flow. */
export async function startRedditOAuth(appOrigin: string): Promise<{
  authorizeUrl: string;
  redirectUri: string;
  state: string;
}> {
  const provider = await configuredRedditCreds();
  const client = resolveRedditClient(provider);
  const redirectUri = redditRedirectUri(appOrigin);
  const state = randomBytes(24).toString('base64url');
  await withPendingLock(() => writePendingUnlocked({
    state,
    redirectUri,
    clientId: client.clientId,
    createdAt: new Date().toISOString(),
    generation: currentOAuthGeneration('reddit'),
  }));

  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    duration: 'permanent',
    scope: REDDIT_SCOPES.join(' '),
  });
  return { authorizeUrl: `${REDDIT_AUTHORIZE_URL}?${params}`, redirectUri, state };
}

function normalizeScopes(value: RedditTokenResponse['scope'], fallback: readonly string[]): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : fallback;
  return [...new Set(items.map((scope) => scope.trim()).filter(Boolean))];
}

function identifyingUserAgent(provider: RedditCreds): string {
  const configured = provider.userAgent?.trim() || process.env.REDDIT_USER_AGENT?.trim();
  const version = process.env.npm_package_version?.trim() || '0.2.0';
  const username = provider.username?.trim();
  const value = configured
    || (username
      ? `desktop:shiba-studio:v${version} (by /u/${username})`
      : `desktop:shiba-studio:v${version} (local operator; configure contact username)`);
  if (/[\r\n]/.test(value) || value.length > 512) {
    throw new Error('Reddit User-Agent must be a single line no longer than 512 characters');
  }
  return value;
}

async function redditError(response: Response, label: string): Promise<Error> {
  let detail = '';
  try {
    const text = (await response.text()).slice(0, 1_000);
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: unknown; error_description?: unknown; message?: unknown };
        detail = String(body.error_description || body.error || body.message || '').slice(0, 500);
      } catch {
        detail = text.replace(/\s+/g, ' ').slice(0, 500);
      }
    }
  } catch {
    /* response body is optional */
  }
  return new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function postToken(
  form: URLSearchParams,
  client: RedditOAuthClient,
  provider: RedditCreds,
): Promise<RedditTokenResponse> {
  const response = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': identifyingUserAgent(provider),
    },
    body: form.toString(),
    cache: 'no-store',
    signal: networkSignal(),
  });
  if (!response.ok) throw await redditError(response, 'Reddit OAuth token exchange');
  const result = await response.json() as RedditTokenResponse;
  if (result.error) {
    throw new Error(`Reddit OAuth token exchange failed: ${result.error_description || result.error}`);
  }
  return result;
}

function tokenPatch(
  result: RedditTokenResponse,
  previousRefreshToken = '',
  fallbackScopes: readonly string[] = REDDIT_SCOPES,
): RedditTokenPatch {
  const accessToken = result.access_token?.trim() || '';
  const refreshToken = result.refresh_token?.trim() || previousRefreshToken;
  if (!accessToken) throw new Error('Reddit returned no OAuth access token');
  if (!refreshToken) throw new Error('Reddit returned no permanent refresh token; start sign-in again');
  const expiresIn = Number(result.expires_in);
  const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return {
    accessToken,
    refreshToken,
    tokenExpiry: new Date(Date.now() + lifetimeSeconds * 1_000).toISOString(),
    scopes: normalizeScopes(result.scope, fallbackScopes),
  };
}

function assertRequiredScopes(scopes: readonly string[]): void {
  const missing = REDDIT_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) {
    throw new Error(`Reddit did not grant required scope(s): ${missing.join(', ')}`);
  }
}

async function fetchRedditIdentity(
  accessToken: string,
  provider: RedditCreds,
): Promise<{ username?: string; userId?: string } | null> {
  const response = await fetch(`${REDDIT_API_ORIGIN}/api/v1/me?raw_json=1`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': identifyingUserAgent(provider),
    },
    cache: 'no-store',
    signal: networkSignal(),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw await redditError(response, 'Reddit identity lookup');
    }
    return null;
  }
  const body = await response.json() as { name?: unknown; id?: unknown };
  return {
    username: typeof body.name === 'string' ? body.name : undefined,
    userId: typeof body.id === 'string' ? body.id : undefined,
  };
}

/** Consume the exact one-time state, exchange the code, and store the session. */
async function exchangeRedditCodeUnlocked(
  code: string,
  state: string | undefined,
  appOrigin: string,
): Promise<{ username?: string; userId?: string }> {
  const normalizedCode = code.trim();
  const normalizedState = state?.trim() || '';
  if (!normalizedCode) throw new Error('Missing Reddit authorization code');
  if (!normalizedState) throw new Error('Missing Reddit OAuth state');

  const provider = await configuredRedditCreds();
  const client = resolveRedditClient(provider);
  const redirectUri = redditRedirectUri(appOrigin);
  const pending = await consumePendingState(normalizedState, redirectUri, client.clientId);

  const result = await postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code: normalizedCode,
    redirect_uri: redirectUri,
  }), client, provider);
  const patch = tokenPatch(result);
  assertRequiredScopes(patch.scopes);

  const identity = await fetchRedditIdentity(patch.accessToken, { ...provider, ...patch });
  if (currentOAuthGeneration('reddit') !== Number(pending.generation || 0)) {
    throw new Error('Reddit sign-in was cancelled by a newer disconnect');
  }
  await updateIntegrationConfig('reddit', (current) => ({
    ...(current || {}),
    ...patch,
    username: identity?.username,
    userId: identity?.userId,
  }));
  return identity || {};
}

export function exchangeRedditCode(
  code: string,
  state: string | undefined,
  appOrigin: string,
): Promise<{ username?: string; userId?: string }> {
  return withOAuthMutationLock(() => exchangeRedditCodeUnlocked(code, state, appOrigin));
}

function tokenUsable(provider: RedditCreds): boolean {
  if (!provider.accessToken?.trim()) return false;
  if (!provider.tokenExpiry?.trim()) return true;
  const expiresAt = Date.parse(provider.tokenExpiry);
  return Number.isFinite(expiresAt) && expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

function refreshKey(provider: RedditCreds, client: RedditOAuthClient): string {
  return createHash('sha256')
    .update(`${client.clientId}\u0000${provider.refreshToken || ''}`)
    .digest('hex');
}

function applyPatch(target: IntegrationCreds | undefined, patch: RedditTokenPatch): void {
  if (!target) return;
  target.reddit = { ...(target.reddit || {}), ...patch };
}

async function persistRefreshIfCurrent(provider: RedditCreds, patch: RedditTokenPatch): Promise<void> {
  const expectedRefreshToken = provider.refreshToken?.trim() || '';
  await updateIntegrationConfig('reddit', (current) => {
    if (!current || !expectedRefreshToken || current.refreshToken !== expectedRefreshToken) return current;
    return { ...current, ...patch };
  });
}

async function refreshRedditToken(provider: RedditCreds, explicit?: IntegrationCreds): Promise<string> {
  const refreshToken = provider.refreshToken?.trim() || '';
  if (!refreshToken) throw new Error('Reddit OAuth session cannot refresh; sign in again');
  const client = resolveRedditClient(provider);
  const key = refreshKey(provider, client);
  const generation = currentOAuthGeneration('reddit');
  let pending = refreshes.get(key);
  if (!pending) {
    pending = (async () => {
      const result = await postToken(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }), client, provider);
      const patch = tokenPatch(
        result,
        refreshToken,
        provider.scopes?.length ? provider.scopes : REDDIT_SCOPES,
      );
      assertRequiredScopes(patch.scopes);
      await withOAuthMutationLock(async () => {
        if (currentOAuthGeneration('reddit') !== generation) {
          throw new Error('Reddit OAuth refresh was cancelled by a newer disconnect');
        }
        await persistRefreshIfCurrent(provider, patch);
      });
      return patch;
    })();
    refreshes.set(key, pending);
    void pending.finally(() => {
      if (refreshes.get(key) === pending) refreshes.delete(key);
    }).catch(() => undefined);
  }
  const patch = await pending;
  applyPatch(explicit, patch);
  return patch.accessToken;
}

async function sourceCreds(explicit?: IntegrationCreds): Promise<RedditCreds> {
  return explicit ? (explicit.reddit || {}) : configuredRedditCreds();
}

/** Return a fresh token or null when Reddit has never been connected. */
export async function getValidRedditToken(creds?: IntegrationCreds): Promise<string | null> {
  const provider = await sourceCreds(creds);
  if (tokenUsable(provider)) return provider.accessToken!.trim();
  if (provider.refreshToken?.trim()) return refreshRedditToken(provider, creds);
  if (provider.accessToken?.trim()) {
    throw new Error('Reddit OAuth session expired and cannot refresh; sign in again');
  }
  return null;
}

async function forceRefreshAfterUnauthorized(
  creds: IntegrationCreds | undefined,
  rejectedToken: string,
): Promise<string> {
  const provider = await sourceCreds(creds);
  if (provider.accessToken?.trim() && provider.accessToken.trim() !== rejectedToken && tokenUsable(provider)) {
    return provider.accessToken.trim();
  }

  // A concurrent caller may already have rotated the global token. Reuse it
  // instead of needlessly rotating the same refresh token a second time.
  const latest = await configuredRedditCreds();
  if (
    provider.refreshToken?.trim()
    && latest.refreshToken === provider.refreshToken
    && latest.accessToken?.trim()
    && latest.accessToken.trim() !== rejectedToken
    && tokenUsable(latest)
  ) {
    const patch: RedditTokenPatch = {
      accessToken: latest.accessToken,
      refreshToken: latest.refreshToken,
      tokenExpiry: latest.tokenExpiry || new Date(Date.now() + 3600_000).toISOString(),
      scopes: latest.scopes || [],
    };
    applyPatch(creds, patch);
    return latest.accessToken;
  }
  return refreshRedditToken(provider, creds);
}

function redditApiUrl(input: string): string {
  const url = new URL(input, `${REDDIT_API_ORIGIN}/`);
  if (url.origin !== REDDIT_API_ORIGIN) {
    throw new Error('Reddit OAuth credentials may only be sent to oauth.reddit.com');
  }
  return url.toString();
}

/**
 * Authenticated Reddit Data API fetch.
 *
 * `retryUnauthorized` is deliberately opt-in and honored only for GET/HEAD.
 * A POST (especially /api/submit) may have succeeded before its response was
 * lost, so replaying it could duplicate user-visible content.
 */
export async function redditOAuthFetch(
  pathOrUrl: string,
  init: RedditOAuthRequestInit = {},
  creds?: IntegrationCreds,
): Promise<Response> {
  const { retryUnauthorized = false, ...fetchInit } = init;
  const method = (fetchInit.method || 'GET').toUpperCase();
  const canRetryUnauthorized = retryUnauthorized === true && (method === 'GET' || method === 'HEAD');
  const token = await getValidRedditToken(creds);
  if (!token) throw new Error('Reddit is not connected; sign in from Core Integrations');

  const provider = await sourceCreds(creds);
  const headers = new Headers(fetchInit.headers);
  headers.set('Accept', headers.get('Accept') || 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('User-Agent', identifyingUserAgent(provider));
  const url = redditApiUrl(pathOrUrl);
  const requestInit: RequestInit = { ...fetchInit, method, headers, cache: fetchInit.cache || 'no-store' };
  const response = await fetch(url, { ...requestInit, signal: networkSignal(fetchInit.signal) });
  if (response.status !== 401 || !canRetryUnauthorized) return response;

  const refreshed = await forceRefreshAfterUnauthorized(creds, token);
  const retryHeaders = new Headers(headers);
  retryHeaders.set('Authorization', `Bearer ${refreshed}`);
  return fetch(url, { ...requestInit, headers: retryHeaders, signal: networkSignal(fetchInit.signal) });
}

export async function getRedditOAuthStatus(): Promise<RedditOAuthStatus> {
  const bundledClient = bundledRedditClient() !== null;
  const clientReady = await isRedditClientReady();
  let provider = await configuredRedditCreds();
  if (!provider.accessToken?.trim() && !provider.refreshToken?.trim()) {
    return {
      connected: false,
      expired: false,
      clientReady,
      bundledClient,
      username: provider.username,
      userId: provider.userId,
      scopes: provider.scopes || [],
    };
  }

  try {
    const token = await getValidRedditToken();
    provider = await configuredRedditCreds();
    return {
      connected: !!token,
      expired: false,
      clientReady,
      bundledClient,
      username: provider.username,
      userId: provider.userId,
      scopes: provider.scopes || [],
      expiresAt: provider.tokenExpiry,
    };
  } catch (error: unknown) {
    return {
      connected: false,
      expired: true,
      clientReady,
      bundledClient,
      username: provider.username,
      userId: provider.userId,
      scopes: provider.scopes || [],
      expiresAt: provider.tokenExpiry,
      error: error instanceof Error ? error.message : 'Reddit OAuth session could not refresh',
    };
  }
}

/** Revoke the Reddit session, then clear local tokens even when revoke fails. */
async function disconnectRedditUnlocked(): Promise<{ revoked: boolean; warning?: string }> {
  advanceOAuthGeneration('reddit');
  const provider = await configuredRedditCreds();
  let revoked = false;
  let warning: string | undefined;
  const cleanupErrors: unknown[] = [];
  try { await withPendingLock(clearPendingUnlocked); }
  catch (error) { cleanupErrors.push(error); }
  try {
    await updateIntegrationConfig('reddit', (current) => current ? {
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      userAgent: current.userAgent,
    } : current);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const token = provider.refreshToken?.trim() || provider.accessToken?.trim() || '';
    if (token) {
      const client = resolveRedditClient(provider);
      const response = await fetch(REDDIT_REVOKE_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': identifyingUserAgent(provider),
        },
        body: new URLSearchParams({
          token,
          token_type_hint: provider.refreshToken?.trim() ? 'refresh_token' : 'access_token',
        }).toString(),
        cache: 'no-store',
        signal: networkSignal(),
      });
      if (response.ok) revoked = true;
      else warning = (await redditError(response, 'Reddit token revocation')).message;
    }
  } catch (error: unknown) {
    warning = error instanceof Error ? error.message : 'Reddit token revocation failed';
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Reddit local disconnect cleanup was incomplete');
  return { revoked, ...(warning ? { warning } : {}) };
}

export function disconnectReddit(): Promise<{ revoked: boolean; warning?: string }> {
  return withOAuthMutationLock(disconnectRedditUnlocked);
}
