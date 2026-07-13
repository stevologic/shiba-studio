import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NextRequest } from 'next/server';
import { POST as startRoute } from '../app/api/xai-oauth/start/route';
import { POST as exchangeRoute } from '../app/api/xai-oauth/exchange/route';
import { GET as statusRoute } from '../app/api/xai-oauth/status/route';
import { POST as logoutRoute } from '../app/api/xai-oauth/logout/route';
import { GET as callbackRoute } from '../app/api/xai-oauth/callback/route';
import { GET as modelsRoute } from '../app/api/models/route';
import { setPersistenceDataDir } from '../lib/persistence';
import {
  buildAuthorizeUrl,
  clearOAuthSession,
  describeCloudAuthPrecedence,
  ensureCloudAuth,
  fetchCloudWithAuth,
  generatePkce,
  getValidAccessToken,
  isSessionExpired,
  parseOAuthCallbackInput,
  resolveCloudBearer,
  saveOAuthSession,
  sessionFromTokenResponse,
  setOAuthDataDir,
  setTokenFetcher,
  startOAuthFlow,
  type XaiOAuthSession,
} from '../lib/xai-oauth';
import { clearApiKey, getApiKey } from '../lib/grok-client';
import type { AppConfig } from '../lib/types';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
    throw new Error(msg);
  }
  passed++;
  console.log(`ok: ${msg}`);
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-oauth-'));
  setOAuthDataDir(dir);
  setPersistenceDataDir(dir);
  try {
    return await fn(dir);
  } finally {
    setOAuthDataDir(null);
    setPersistenceDataDir(null);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runUnitTests() {
  console.log('\n=== unit tests ===');

  const pkce = generatePkce();
  assert(pkce.codeVerifier.length >= 43, 'PKCE verifier length');
  assert(pkce.codeChallenge.length >= 43, 'PKCE challenge length');

  const parsed = parseOAuthCallbackInput('https://local/cb?code=abc123&state=xyz');
  assert(parsed.code === 'abc123' && parsed.state === 'xyz', 'parse full callback URL');

  const bare = parseOAuthCallbackInput('plain-code-value');
  assert(bare.code === 'plain-code-value', 'parse bare code');

  const tokens = sessionFromTokenResponse({
    access_token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MSIsImVtYWlsIjoidGVzdEB4LmFpIiwibmFtZSI6IlRlc3QifQ.sig',
    refresh_token: 'rt-1',
    expires_in: 3600,
    scope: 'api:access',
  });
  assert(tokens.accessToken.startsWith('eyJ'), 'session from token response');
  assert(tokens.refreshToken === 'rt-1', 'refresh token stored');
  assert(tokens.email === 'test@x.ai', 'email decoded from JWT');

  const expiredSession: XaiOAuthSession = {
    accessToken: 'old',
    refreshToken: 'rt-old',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    connectedAt: new Date().toISOString(),
    oidcClientId: 'client',
  };
  assert(isSessionExpired(expiredSession), 'expired session detected');

  await withTempDataDir(async () => {
    const future: XaiOAuthSession = {
      accessToken: 'live-token',
      refreshToken: 'rt-live',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      email: 'user@example.com',
      connectedAt: new Date().toISOString(),
      oidcClientId: 'client',
    };
    await saveOAuthSession(future);

    const token = await getValidAccessToken();
    assert(token === 'live-token', 'valid OAuth session yields bearer token');

    const cfg: AppConfig = {
      xaiApiKey: '',
      integrations: {},
      defaultWorkspace: process.cwd(),
      cloudAuthMode: 'oauth',
    };
    const auth = await resolveCloudBearer(cfg);
    assert(auth.hasCloudAuth && auth.source === 'oauth' && auth.token === 'live-token', 'oauth-only hasCloudAuth true');

    let refreshCalls = 0;
    setTokenFetcher(async (_url, init) => {
      refreshCalls++;
      const body = String((init as RequestInit).body || '');
      assert(body.includes('grant_type=refresh_token'), 'refresh grant used');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        access_token: 'refreshed-token',
        refresh_token: 'rt-live',
        expires_in: 7200,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await saveOAuthSession({
      ...future,
      expiresAt: new Date(Date.now() - 5_000).toISOString(),
    });

    const refreshedTogether = await Promise.all(
      Array.from({ length: 12 }, () => getValidAccessToken()),
    );
    assert(
      refreshedTogether.every((token) => token === 'refreshed-token') && refreshCalls === 1,
      'concurrent expiry checks share one refresh and persist its token',
    );

    const stored = await getValidAccessToken();
    assert(stored === 'refreshed-token', 'refreshed token persisted');

    await clearOAuthSession();
    const afterClear = await resolveCloudBearer(cfg);
    assert(!afterClear.hasCloudAuth, 'disconnect clears OAuth state');

    setTokenFetcher(null);
  });

  const keyCfg: AppConfig = {
    xaiApiKey: 'xai-test-key',
    integrations: {},
    defaultWorkspace: process.cwd(),
    cloudAuthMode: 'api_key',
  };
  const keyAuth = await resolveCloudBearer(keyCfg);
  assert(keyAuth.source === 'api_key' && keyAuth.token === 'xai-test-key', 'api key path');

  const bothCfg: AppConfig = {
    xaiApiKey: 'xai-test-key',
    integrations: {},
    defaultWorkspace: process.cwd(),
    cloudAuthMode: 'oauth',
  };
  await withTempDataDir(async () => {
    await saveOAuthSession({
      accessToken: 'oauth-tok',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      connectedAt: new Date().toISOString(),
      oidcClientId: 'client',
    });
    const both = await resolveCloudBearer(bothCfg);
    assert(both.source === 'oauth' && both.token === 'oauth-tok', 'mode oauth prefers oauth when both configured');
  });

  const bothDefault = await resolveCloudBearer({
    ...bothCfg,
    cloudAuthMode: 'api_key',
  });
  assert(bothDefault.source === 'api_key', 'default mode prefers api key when both configured');

  await withTempDataDir(async () => {
    await saveOAuthSession({
      accessToken: 'oauth-cache-token',
      refreshToken: 'rt-cache',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      connectedAt: new Date().toISOString(),
      oidcClientId: 'client',
    });
    clearApiKey();
    const cfg: AppConfig = {
      xaiApiKey: 'xai-stored-key',
      integrations: {},
      defaultWorkspace: process.cwd(),
      cloudAuthMode: 'oauth',
    };
    const token = await ensureCloudAuth(cfg);
    assert(token === 'oauth-cache-token', 'ensureCloudAuth honors cloudAuthMode oauth over stored API key');
    assert(getApiKey() === 'oauth-cache-token', 'cached key matches oauth when mode=oauth');
  });

  await withTempDataDir(async () => {
    await saveOAuthSession({
      accessToken: 'stale-oauth',
      refreshToken: 'rt-401',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      connectedAt: new Date().toISOString(),
      oidcClientId: 'client',
    });
    let calls = 0;
    setTokenFetcher(async (url, init) => {
      calls++;
      const method = (init as RequestInit).method || 'GET';
      const body = String((init as RequestInit).body || '');
      if (url.includes('/oauth2/token') && body.includes('refresh_token')) {
        return new Response(JSON.stringify({
          access_token: 'fresh-after-401',
          refresh_token: 'rt-401',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (calls === 1 && method === 'GET') {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const cfg: AppConfig = {
      xaiApiKey: '',
      integrations: {},
      defaultWorkspace: process.cwd(),
      cloudAuthMode: 'oauth',
    };
    const res = await fetchCloudWithAuth('https://api.x.ai/v1/models', { method: 'GET' }, { cfg });
    assert(res.status === 200, 'fetchCloudWithAuth retries after 401 with refreshed oauth token');
    assert(getApiKey() === 'fresh-after-401', '401 refresh updates cached bearer');
    setTokenFetcher(null);
  });
}

async function runApiRouteTests() {
  console.log('\n=== api-route HTTP handler tests ===');

  await withTempDataDir(async (dir) => {
    const startRes = await startRoute(new NextRequest('http://127.0.0.1:3000/api/xai-oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'http://127.0.0.1:3000' }),
    }));
    const startJson = await startRes.json();
    assert(startJson.ok && startJson.authorizeUrl.includes('auth.x.ai/oauth2/authorize'), 'POST /start returns authorize URL');

    setTokenFetcher(async () => new Response(JSON.stringify({
      access_token: 'route-access',
      refresh_token: 'route-refresh',
      expires_in: 1800,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const exchangeRes = await exchangeRoute(new NextRequest('http://127.0.0.1:3000/api/xai-oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123', state: startJson.state }),
    }));
    const exchangeJson = await exchangeRes.json();
    assert(exchangeJson.ok && exchangeJson.status?.connected === true, 'POST /exchange persists tokens');

    const configRaw = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    const configSaved = JSON.parse(configRaw) as AppConfig;
    assert(configSaved.cloudAuthMode === 'oauth', 'OAuth-only exchange persists cloudAuthMode oauth');

    const statusRes = await statusRoute();
    const statusJson = await statusRes.json();
    assert(statusJson.ok && statusJson.connected === true, 'GET /status connected=true');

    const logoutRes = await logoutRoute();
    const logoutJson = await logoutRes.json();
    assert(logoutJson.ok && logoutJson.connected === false, 'POST /logout clears session');

    const statusAfter = await statusRoute();
    const statusAfterJson = await statusAfter.json();
    assert(statusAfterJson.connected === false, 'status connected=false after logout');

    await startOAuthFlow('http://127.0.0.1:3000');
    setTokenFetcher(async () => new Response(JSON.stringify({
      access_token: 'cb-access',
      refresh_token: 'cb-refresh',
      expires_in: 1800,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const pending = await import('../lib/xai-oauth').then((m) => m.loadOAuthPending());
    const cbRes = await callbackRoute(new NextRequest(
      `http://127.0.0.1:3000/api/xai-oauth/callback?code=cb-code&state=${pending?.state || ''}`,
    ));
    assert(cbRes.status === 200, 'GET /callback returns the hand-back page after exchange');
    const cbHtml = await cbRes.text();
    // The hand-back script embeds the full postMessage payload
    // (JSON.stringify(`${channel}:connected`)) — assert the literal message.
    assert(cbHtml.includes('shiba-oauth:connected'), 'callback page announces success on the shiba-oauth channel');
    assert(cbHtml.includes('window.close'), 'callback popup closes itself');
    assert(cbHtml.includes('/settings?oauth=connected'), 'callback falls back to same-tab return');

    setTokenFetcher(null);
  });
}

async function runModelsRouteCheck() {
  console.log('\n=== models route field check ===');
  const modelsRes = await modelsRoute();
  const modelsJson = await modelsRes.json();
  assert('hasCloudAuth' in modelsJson, 'models route exposes hasCloudAuth');
  assert(!('hasKey' in modelsJson), 'models route does not expose hasKey cloud-auth flag');
}

async function runUiStructuralCheck() {
  console.log('\n=== settings UI structural check ===');
  const src = await fs.readFile(path.join(process.cwd(), 'components', 'shiba-studio.tsx'), 'utf8');
  assert(src.includes('xAI Grok API Key'), 'settings has API key section');
  assert(src.includes('OAuth with X'), 'settings has OAuth section');
  assert(src.includes('accounts.x.ai'), 'settings references accounts.x.ai');
  assert(src.includes('Sign in with X'), 'settings has sign-in control');
  assert(src.includes('Disconnect'), 'settings has disconnect control');
  assert(src.includes('useSearchParams'), 'settings reads OAuth query params');
  assert(src.includes("oauth === 'connected'"), 'settings handles oauth=connected');
  assert(src.includes("oauth === 'error'"), 'settings handles oauth=error');
  assert(src.includes('startOAuthStatusPolling'), 'settings polls OAuth status after sign-in');
  assert(src.includes('hasCloudAuth'), 'settings uses hasCloudAuth from models API');
}

async function writeCloudAuthMatrix() {
  const lines = [
    'Cloud auth resolver precedence matrix',
    '',
    `api_key only: ${JSON.stringify(describeCloudAuthPrecedence({ hasKey: true, hasOAuth: false, mode: 'api_key' }))}`,
    `oauth only: ${JSON.stringify(describeCloudAuthPrecedence({ hasKey: false, hasOAuth: true, mode: 'api_key' }))}`,
    `both + api_key mode: ${JSON.stringify(describeCloudAuthPrecedence({ hasKey: true, hasOAuth: true, mode: 'api_key' }))}`,
    `both + oauth mode: ${JSON.stringify(describeCloudAuthPrecedence({ hasKey: true, hasOAuth: true, mode: 'oauth' }))}`,
    '',
    'authorize URL sample:',
    buildAuthorizeUrl({
      state: 'test-state',
      codeChallenge: generatePkce().codeChallenge,
      redirectUri: 'http://127.0.0.1:3000/api/xai-oauth/callback',
    }),
  ];
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.writeFile(path.join(SCRATCH, 'cloud-auth-matrix.txt'), lines.join('\n'));
  console.log('wrote cloud-auth-matrix.txt');
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  const unitLog = path.join(SCRATCH, 'xai-oauth-unit.log');
  const apiLog = path.join(SCRATCH, 'xai-oauth-api.log');
  const uiLog = path.join(SCRATCH, 'settings-oauth-ui.log');

  const unitOut: string[] = [];
  const apiOut: string[] = [];
  const uiOut: string[] = [];

  const origLog = console.log;
  const origErr = console.error;

  console.log = (...args) => { const line = args.join(' '); unitOut.push(line); origLog(...args); };
  console.error = (...args) => { const line = args.join(' '); unitOut.push(line); origErr(...args); };
  await runUnitTests();
  console.log = origLog;
  console.error = origErr;
  await fs.writeFile(unitLog, unitOut.join('\n'));

  console.log = (...args) => { const line = args.join(' '); apiOut.push(line); origLog(...args); };
  console.error = (...args) => { const line = args.join(' '); apiOut.push(line); origErr(...args); };
  await runApiRouteTests();
  console.log = origLog;
  console.error = origErr;
  await fs.writeFile(apiLog, apiOut.join('\n'));

  const polishOut: string[] = [];
  console.log = (...args) => { const line = args.join(' '); polishOut.push(line); origLog(...args); };
  console.error = (...args) => { const line = args.join(' '); polishOut.push(line); origErr(...args); };
  await runModelsRouteCheck();
  console.log = origLog;
  console.error = origErr;
  await fs.writeFile(path.join(SCRATCH, 'xai-oauth-polish.log'), polishOut.join('\n'));

  console.log = (...args) => { const line = args.join(' '); uiOut.push(line); origLog(...args); };
  console.error = (...args) => { const line = args.join(' '); uiOut.push(line); origErr(...args); };
  await runUiStructuralCheck();
  console.log = origLog;
  console.error = origErr;
  await fs.writeFile(uiLog, uiOut.join('\n'));

  await writeCloudAuthMatrix();

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`logs: ${unitLog}, ${apiLog}, ${uiLog}`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
