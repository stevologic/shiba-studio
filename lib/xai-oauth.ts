import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import type { AppConfig } from './types';
import type { CloudAuthMode, XaiOAuthPublicStatus } from './xai-oauth-types';

export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_AUTHORIZE = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_TOKEN = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_OAUTH_USERINFO = `${XAI_OAUTH_ISSUER}/oauth2/userinfo`;
export const XAI_OAUTH_SCOPES =
  'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';

let dataDirOverride: string | null = null;

export function setOAuthDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function oauthDataDir(): string {
  return dataDirOverride || dataDir();
}

function sessionFile(): string {
  return path.join(oauthDataDir(), 'xai-oauth.json');
}

function pendingFile(): string {
  return path.join(oauthDataDir(), 'xai-oauth-pending.json');
}
const EXPIRY_SKEW_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export interface XaiOAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  connectedAt: string;
  oidcClientId: string;
}

export interface OAuthPendingState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export type TokenFetcher = (url: string, init: RequestInit) => Promise<Response>;

let tokenFetcher: TokenFetcher = (url, init) => fetch(url, init);

export function setTokenFetcher(fetcher: TokenFetcher | null): void {
  tokenFetcher = fetcher || ((url, init) => fetch(url, init));
}

async function ensureData() {
  await fs.mkdir(oauthDataDir(), { recursive: true });
}

export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function generateOAuthState(): string {
  return randomBytes(16).toString('base64url');
}

export function getOAuthRedirectUri(origin?: string): string {
  if (origin?.trim()) {
    return `${origin.replace(/\/$/, '')}/api/xai-oauth/callback`;
  }
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}/api/xai-oauth/callback`;
}

export function buildAuthorizeUrl(input: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  // nonce + referrer mirror the grok-cli's own authorize request — the same
  // OIDC client validated end-to-end against auth.x.ai.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: XAI_OAUTH_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    nonce: randomBytes(16).toString('base64url'),
    referrer: 'grok-build',
  });
  return `${XAI_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export function parseOAuthCallbackInput(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty callback input');

  try {
    const asUrl = trimmed.includes('://') ? new URL(trimmed) : new URL(trimmed, 'http://local');
    const code = asUrl.searchParams.get('code');
    const state = asUrl.searchParams.get('state') || undefined;
    if (code) return { code, state };
  } catch {
    /* fall through */
  }

  if (trimmed.startsWith('?')) {
    const params = new URLSearchParams(trimmed);
    const code = params.get('code');
    if (code) return { code, state: params.get('state') || undefined };
  }

  if (/^[A-Za-z0-9._-]{8,}$/.test(trimmed) && !trimmed.includes('=')) {
    return { code: trimmed };
  }

  throw new Error('Could not parse authorization code from callback input');
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function sessionFromTokenResponse(
  tokens: TokenExchangeResult,
  existing?: XaiOAuthSession | null,
): XaiOAuthSession {
  const now = Date.now();
  const expiresIn = Number(tokens.expires_in ?? 3600);
  const payload = decodeJwtPayload(tokens.access_token);
  const email = typeof payload?.email === 'string' ? payload.email : existing?.email;
  const userId =
    typeof payload?.sub === 'string'
      ? payload.sub
      : typeof payload?.principal_id === 'string'
        ? payload.principal_id
        : existing?.userId;
  const displayName =
    typeof payload?.name === 'string'
      ? payload.name
      : typeof payload?.given_name === 'string'
        ? payload.given_name
        : existing?.displayName;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing?.refreshToken || '',
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    scope: tokens.scope || existing?.scope,
    email,
    displayName,
    userId,
    connectedAt: existing?.connectedAt || new Date(now).toISOString(),
    oidcClientId: XAI_OAUTH_CLIENT_ID,
  };
}

export function isSessionExpired(session: XaiOAuthSession, now = Date.now()): boolean {
  const exp = Date.parse(session.expiresAt);
  if (!Number.isFinite(exp)) return true;
  return exp - EXPIRY_SKEW_MS <= now;
}

export function maskEmail(email?: string): string | undefined {
  if (!email?.includes('@')) return email;
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `**@${domain}`;
  return `${user.slice(0, 2)}***@${domain}`;
}

/** OAuth token fields sealed at rest via the machine key (see lib/secure-store.ts). */
const OAUTH_SECRET_FIELDS = ['accessToken', 'refreshToken', 'idToken'] as const;

export async function loadOAuthSession(): Promise<XaiOAuthSession | null> {
  await ensureData();
  try {
    const raw = await fs.readFile(sessionFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.refreshToken) return null;
    const { decryptSecret, isEncryptedSecret } = await import('./secure-store');
    let hadPlaintext = false;
    for (const field of OAUTH_SECRET_FIELDS) {
      const v = parsed[field];
      if (typeof v === 'string' && v) {
        if (isEncryptedSecret(v)) parsed[field] = decryptSecret(v);
        else hadPlaintext = true;
      }
    }
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    if (hadPlaintext) {
      // One-time migration: re-write legacy plaintext tokens sealed.
      await saveOAuthSession(parsed as XaiOAuthSession);
    }
    return parsed as XaiOAuthSession;
  } catch {
    return null;
  }
}

export async function saveOAuthSession(session: XaiOAuthSession | null): Promise<void> {
  await ensureData();
  if (!session) {
    try {
      await fs.unlink(sessionFile());
    } catch {
      /* ignore */
    }
    return;
  }
  const { encryptSecret } = await import('./secure-store');
  const sealed: Record<string, unknown> = { ...session };
  for (const field of OAUTH_SECRET_FIELDS) {
    const v = sealed[field];
    if (typeof v === 'string' && v) sealed[field] = encryptSecret(v);
  }
  await fs.writeFile(sessionFile(), JSON.stringify(sealed, null, 2));
}

export async function clearOAuthSession(): Promise<void> {
  await saveOAuthSession(null);
}

export async function saveOAuthPending(pending: OAuthPendingState | null): Promise<void> {
  await ensureData();
  if (!pending) {
    try {
      await fs.unlink(pendingFile());
    } catch {
      /* ignore */
    }
    return;
  }
  await fs.writeFile(pendingFile(), JSON.stringify(pending, null, 2));
}

export async function loadOAuthPending(): Promise<OAuthPendingState | null> {
  await ensureData();
  try {
    const raw = await fs.readFile(pendingFile(), 'utf8');
    const parsed = JSON.parse(raw) as OAuthPendingState;
    if (!parsed?.state || !parsed?.codeVerifier) return null;
    const age = Date.now() - Date.parse(parsed.createdAt);
    if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
      await saveOAuthPending(null);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function startOAuthFlow(origin?: string): Promise<{
  authorizeUrl: string;
  state: string;
  redirectUri: string;
}> {
  const pkce = generatePkce();
  const state = generateOAuthState();
  // auth.x.ai's grok-cli client only registers RFC 8252 loopback redirects
  // (http://127.0.0.1:{any port}/callback) — the app's own Next.js origin is
  // rejected with "redirect_uri does not match any registered URI". Bind a
  // disposable listener on a random port, exactly like the CLI does.
  const appOrigin = origin?.trim() || getOAuthRedirectUri().replace(/\/api\/xai-oauth\/callback$/, '');
  const { startOAuthLoopback } = await import('./oauth-loopback');
  const { redirectUri } = await startOAuthLoopback(appOrigin);
  await saveOAuthPending({
    state,
    codeVerifier: pkce.codeVerifier,
    redirectUri,
    createdAt: new Date().toISOString(),
  });
  return {
    authorizeUrl: buildAuthorizeUrl({
      state,
      codeChallenge: pkce.codeChallenge,
      redirectUri,
    }),
    state,
    redirectUri,
  };
}

async function postToken(body: URLSearchParams): Promise<TokenExchangeResult> {
  const res = await tokenFetcher(XAI_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let data: TokenExchangeResult & { error?: string; error_description?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || text.slice(0, 200);
    throw new Error(`OAuth token error ${res.status}: ${msg}`);
  }
  return data;
}

export async function exchangeOAuthCode(
  code: string,
  state?: string,
): Promise<XaiOAuthSession> {
  const pending = await loadOAuthPending();
  if (!pending) throw new Error('OAuth session expired — start sign-in again');
  if (state && state !== pending.state) {
    throw new Error('OAuth state mismatch — start sign-in again');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  });

  const tokens = await postToken(body);
  const session = sessionFromTokenResponse(tokens);
  if (!session.refreshToken) {
    throw new Error('OAuth response missing refresh token');
  }

  await saveOAuthSession(session);
  await saveOAuthPending(null);
  await applyOAuthOnlyCloudAuthMode();
  return session;
}

/** When OAuth is the only cloud credential, persist explicit oauth preference. */
export async function applyOAuthOnlyCloudAuthMode(): Promise<void> {
  const { loadConfig, saveConfig } = await import('./persistence');
  const cfg = await loadConfig();
  if (!cfg.xaiApiKey?.trim()) {
    await saveConfig({ cloudAuthMode: 'oauth' });
  }
}

export async function forceRefreshOAuthAccessToken(expectedAccessToken?: string): Promise<string | null> {
  const session = await loadOAuthSession();
  if (!session?.refreshToken) return null;
  // Another request may already have refreshed the token that received the
  // 401. Reuse that newer token instead of rotating the refresh token again.
  if (expectedAccessToken && session.accessToken !== expectedAccessToken && !isSessionExpired(session)) {
    return session.accessToken;
  }
  try {
    const refreshed = await refreshOAuthSession(session);
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

const oauthRefreshGlobal = globalThis as typeof globalThis & {
  __shibaOAuthRefresh?: Promise<XaiOAuthSession>;
};

async function performOAuthRefresh(
  session: XaiOAuthSession,
): Promise<XaiOAuthSession> {
  if (!session.refreshToken) throw new Error('No refresh token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: session.refreshToken,
  });

  const tokens = await postToken(body);
  const next = sessionFromTokenResponse(tokens, session);
  if (!next.refreshToken) next.refreshToken = session.refreshToken;
  await saveOAuthSession(next);
  return next;
}

/** Coalesce concurrent expiry/401 refreshes. OAuth providers commonly rotate
 * refresh tokens, so sending the same old refresh token twice can invalidate
 * the otherwise-successful request. */
export function refreshOAuthSession(session: XaiOAuthSession): Promise<XaiOAuthSession> {
  const existing = oauthRefreshGlobal.__shibaOAuthRefresh;
  if (existing) return existing;
  const pending = performOAuthRefresh(session).finally(() => {
    if (oauthRefreshGlobal.__shibaOAuthRefresh === pending) {
      delete oauthRefreshGlobal.__shibaOAuthRefresh;
    }
  });
  oauthRefreshGlobal.__shibaOAuthRefresh = pending;
  return pending;
}

export async function getValidAccessToken(): Promise<string | null> {
  const session = await loadOAuthSession();
  if (!session?.accessToken) return null;
  if (!isSessionExpired(session)) return session.accessToken;
  if (!session.refreshToken) return null;
  try {
    const refreshed = await refreshOAuthSession(session);
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

export async function getOAuthPublicStatus(): Promise<XaiOAuthPublicStatus> {
  const session = await loadOAuthSession();
  if (!session) {
    return { connected: false, expired: false };
  }
  const expired = isSessionExpired(session);
  const canRefresh = !!session.refreshToken;
  if (expired && canRefresh) {
    const token = await getValidAccessToken();
    if (token) {
      const refreshed = await loadOAuthSession();
      return {
        connected: true,
        expired: false,
        email: maskEmail(refreshed?.email),
        displayName: refreshed?.displayName,
        userId: refreshed?.userId,
        expiresAt: refreshed?.expiresAt,
        connectedAt: refreshed?.connectedAt,
      };
    }
    return {
      connected: false,
      expired: true,
      email: maskEmail(session.email),
      displayName: session.displayName,
      error: 'Session expired — sign in again or use an API key',
    };
  }
  return {
    connected: !expired,
    expired,
    email: maskEmail(session.email),
    displayName: session.displayName,
    userId: session.userId,
    expiresAt: session.expiresAt,
    connectedAt: session.connectedAt,
  };
}

export async function resolveCloudBearer(
  cfg?: AppConfig,
  /** Pin the credential for this call, overriding cloudAuthMode. Used when a
   *  model selection carries an explicit source (oauth-tagged vs token-tagged).
   *  'token' maps to the API key. */
  preferSource?: 'oauth' | 'token',
): Promise<{
  token: string | null;
  source: 'api_key' | 'oauth' | null;
  hasCloudAuth: boolean;
}> {
  const { loadConfig } = await import('./persistence');
  const config = cfg || (await loadConfig());
  const hasKey = !!config.xaiApiKey?.trim();
  const session = await loadOAuthSession();
  const hasOAuth = !!(session?.accessToken && session?.refreshToken);

  // A model-pinned source wins over the global preference — but still falls
  // back to the other credential if the pinned one is unavailable.
  if (preferSource === 'token' && hasKey) {
    return { token: config.xaiApiKey.trim(), source: 'api_key', hasCloudAuth: true };
  }
  if (preferSource === 'oauth' && hasOAuth) {
    const token = await getValidAccessToken();
    if (token) return { token, source: 'oauth', hasCloudAuth: true };
  }

  const mode: CloudAuthMode = config.cloudAuthMode || 'api_key';

  if (mode === 'oauth' && hasOAuth) {
    const token = await getValidAccessToken();
    if (token) return { token, source: 'oauth', hasCloudAuth: true };
  }

  if (hasKey) {
    return { token: config.xaiApiKey.trim(), source: 'api_key', hasCloudAuth: true };
  }

  if (hasOAuth) {
    const token = await getValidAccessToken();
    if (token) return { token, source: 'oauth', hasCloudAuth: true };
  }

  return { token: null, source: null, hasCloudAuth: false };
}

export async function ensureCloudAuth(cfg?: AppConfig): Promise<string | null> {
  const { token } = await resolveCloudBearer(cfg);
  const { setApiKey, clearApiKey } = await import('./grok-client');
  if (token) {
    setApiKey(token);
    return token;
  }
  clearApiKey();
  return null;
}

export async function fetchCloudWithAuth(
  url: string,
  init: RequestInit = {},
  opts?: { keyOverride?: string; keySource?: 'api_key' | 'oauth'; cfg?: AppConfig; preferSource?: 'oauth' | 'token' },
): Promise<Response> {
  const override = opts?.keyOverride?.trim();
  // Request-pinned keys preserve OAuth identity. Treating every override as an
  // API key disabled the one-time 401 refresh path for OAuth-selected models.
  const oauthSession = override ? await loadOAuthSession() : null;
  const auth = override
    ? {
        token: override,
        source: opts?.keySource
          || (oauthSession?.accessToken === override ? 'oauth' as const : 'api_key' as const),
        hasCloudAuth: true,
      }
    : await resolveCloudBearer(opts?.cfg, opts?.preferSource);

  if (!auth.token) {
    throw new Error('Missing cloud credentials. Add an xAI API key or sign in with X (OAuth) in Settings.');
  }

  const { setApiKey } = await import('./grok-client');
  setApiKey(auth.token);

  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${auth.token}`);
  }

  let res = await tokenFetcher(url, { ...init, headers });

  // xAI reports an expired/rotated OAuth bearer as either 401 or a specific
  // 403 bad-credentials response. Inspect a clone so callers still receive
  // the original body when refresh is unavailable; never retry ordinary 403s.
  const oauthBearerRejected = res.status === 401 || (
    res.status === 403
    && /unauthenticated:bad-credentials|OAuth2 access token could not be validated/i
      .test(await res.clone().text().catch(() => ''))
  );
  if (oauthBearerRejected && auth.source === 'oauth') {
    const refreshed = await forceRefreshOAuthAccessToken(auth.token);
    if (refreshed) {
      setApiKey(refreshed);
      headers.set('Authorization', `Bearer ${refreshed}`);
      res = await tokenFetcher(url, { ...init, headers });
    }
  }

  return res;
}

export function describeCloudAuthPrecedence(input: {
  hasKey: boolean;
  hasOAuth: boolean;
  mode: CloudAuthMode;
}): { active: 'api_key' | 'oauth' | null; note: string } {
  if (input.mode === 'oauth' && input.hasOAuth) {
    return { active: 'oauth', note: 'cloudAuthMode=oauth and OAuth session present' };
  }
  if (input.hasKey) {
    return { active: 'api_key', note: 'API key preferred when configured' };
  }
  if (input.hasOAuth) {
    return { active: 'oauth', note: 'OAuth fallback when no API key' };
  }
  return { active: null, note: 'No cloud credentials configured' };
}
