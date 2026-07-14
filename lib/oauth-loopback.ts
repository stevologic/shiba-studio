// Disposable loopback listener for OAuth providers that require an RFC 8252
// redirect. auth.x.ai's grok-cli client accepts only
// http://127.0.0.1:{any-port}/callback, so a one-shot server receives the code,
// exchanges it, hands a small page back to the popup, and frees the port.

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

interface LoopbackGlobals {
  __shibaOAuthLoopback?: { server: Server; port: number; expiry: ReturnType<typeof setTimeout> };
}

const globals = globalThis as unknown as LoopbackGlobals;

export type OAuthHandbackChannel = 'shiba-oauth' | 'shiba-drive';

const HAND_BACK_COPY: Record<OAuthHandbackChannel, {
  query: string;
  returnPath: string;
  provider: string;
  success: string;
}> = {
  'shiba-oauth': {
    query: 'oauth',
    returnPath: '/settings',
    provider: 'X',
    success: 'Grok is connected. Tokens are cached encrypted and refresh automatically.',
  },
  'shiba-drive': {
    query: 'drive',
    returnPath: '/settings',
    provider: 'Google',
    success: 'Google Drive is connected. Tokens are cached encrypted and refresh automatically.',
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON embedded in an inline script must not be able to terminate the tag. */
function scriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function handbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid OAuth hand-back origin');
  }
  return url.origin;
}

/** Headers shared by Next callback routes and the one-shot loopback server. */
export function oauthHandbackHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/**
 * The page an OAuth popup lands on after consent. It postMessages the opener
 * and closes itself; when opened in the same tab it returns to the correct app
 * surface with a provider-specific query parameter.
 */
export function buildHandbackHtml(
  kind: 'connected' | 'error',
  appOrigin: string,
  message?: string,
  channel: OAuthHandbackChannel = 'shiba-oauth',
): string {
  const ok = kind === 'connected';
  const copy = HAND_BACK_COPY[channel];
  const detail = escapeHtml((message || '').slice(0, 300));
  const origin = handbackOrigin(appOrigin);
  const query = new URLSearchParams({ [copy.query]: ok ? 'connected' : 'error' });
  if (!ok) query.set('message', message || 'Sign-in failed');
  const target = `${origin}${copy.returnPath}?${query.toString()}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<title>${ok ? 'Connected - Shiba Studio' : 'Sign-in failed - Shiba Studio'}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#000; color:#f5f5f5; font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif; }
  .card { text-align:center; padding:40px 44px; border:1px solid #333; border-radius:16px; background:#0a0a0a; max-width:420px; }
  .mark { font-size:40px; }
  h1 { font-size:19px; margin:14px 0 6px; letter-spacing:-.02em; }
  p { font-size:13px; color:#a3a3a3; margin:0; line-height:1.6; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${ok ? '&#10003;' : '&#9888;'}</div>
    <h1>${ok ? `Signed in with ${copy.provider}` : 'Sign-in failed'}</h1>
    <p>${ok
      ? `${copy.success}<br/>This window closes itself.`
      : `${detail || 'Something went wrong during the exchange.'}<br/>Returning to Shiba Studio&hellip;`}</p>
  </div>
  <script>
    (function () {
      var ok = ${ok ? 'true' : 'false'};
      var target = ${scriptJson(target)};
      var appOrigin = ${scriptJson(origin)};
      var messageType = ${scriptJson(ok ? `${channel}:connected` : `${channel}:error`)};
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(messageType, appOrigin); } catch (e) {}
        setTimeout(function () { window.close(); }, ok ? 1400 : 5000);
      } else {
        setTimeout(function () { window.location.replace(target); }, ok ? 900 : 2600);
      }
    })();
  </script>
</body>
</html>`;
}

export function stopOAuthLoopback(): void {
  const current = globals.__shibaOAuthLoopback;
  if (!current) return;
  clearTimeout(current.expiry);
  try { current.server.close(); } catch { /* already closed */ }
  globals.__shibaOAuthLoopback = undefined;
}

/** Called with the redirect's query params; returns success + optional error text. */
export type LoopbackExchange = (params: {
  code: string | null;
  state?: string;
  error: string | null;
  errorDescription: string | null;
}) => Promise<{ ok: boolean; message?: string }>;

const defaultXExchange: LoopbackExchange = async ({ code, state, error, errorDescription }) => {
  if (error) return { ok: false, message: errorDescription || error };
  if (!code) return { ok: false, message: 'Missing authorization code' };
  try {
    const { exchangeOAuthCode } = await import('./xai-oauth');
    await exchangeOAuthCode(code, state);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : 'OAuth exchange failed' };
  }
};

/** Bind a one-shot loopback listener for providers that require that redirect. */
export async function startOAuthLoopback(
  appOrigin: string,
  exchange: LoopbackExchange = defaultXExchange,
  channel: OAuthHandbackChannel = 'shiba-oauth',
): Promise<{ port: number; redirectUri: string }> {
  stopOAuthLoopback();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Not found');
        return;
      }
      const result = await exchange({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state') || undefined,
        error: url.searchParams.get('error'),
        errorDescription: url.searchParams.get('error_description'),
      });
      const page = buildHandbackHtml(result.ok ? 'connected' : 'error', appOrigin, result.message, channel);
      res.writeHead(200, oauthHandbackHeaders()).end(page);
      setTimeout(() => stopOAuthLoopback(), 3000);
    } catch {
      try { res.writeHead(500, { 'Cache-Control': 'no-store' }).end(); } catch { /* socket gone */ }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  const port = (server.address() as AddressInfo).port;
  const expiry = setTimeout(() => stopOAuthLoopback(), 5 * 60_000);
  expiry.unref();
  globals.__shibaOAuthLoopback = { server, port, expiry };

  return { port, redirectUri: `http://127.0.0.1:${port}/callback` };
}
