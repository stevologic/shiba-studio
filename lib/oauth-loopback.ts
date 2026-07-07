// Disposable loopback listener for the OAuth redirect. auth.x.ai's grok-cli
// OIDC client only accepts RFC 8252 loopback redirects — http://127.0.0.1:{any
// port}/callback — so the app cannot receive the authorization code on its own
// Next.js port/path. A one-shot server on a random port (exactly what the CLI
// itself does) catches the redirect, exchanges the code, hands a small page
// back to the popup, and frees the port.

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

interface LoopbackGlobals {
  __shibaOAuthLoopback?: { server: Server; port: number; expiry: ReturnType<typeof setTimeout> };
}
const g = globalThis as unknown as LoopbackGlobals;

/** The page the popup lands on after accounts.x.ai redirects back. Opened as a
 *  popup it postMessages the app and closes itself; opened same-tab (popup was
 *  blocked) it bounces back into the app. */
export function buildHandbackHtml(kind: 'connected' | 'error', appOrigin: string, message?: string): string {
  const ok = kind === 'connected';
  const detail = (message || '').replace(/</g, '&lt;').slice(0, 300);
  const target = `${appOrigin.replace(/\/$/, '')}${ok
    ? '/settings?oauth=connected'
    : `/settings?oauth=error&message=${encodeURIComponent(message || 'OAuth sign-in failed')}`}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${ok ? 'Connected — Shiba Studio' : 'Sign-in failed — Shiba Studio'}</title>
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
    <div class="mark">${ok ? '✅' : '⚠️'}</div>
    <h1>${ok ? 'Signed in with X' : 'Sign-in failed'}</h1>
    <p>${ok
      ? 'Grok is connected — tokens are cached encrypted and refresh automatically.<br/>This window closes itself.'
      : `${detail || 'Something went wrong during the exchange.'}<br/>Returning to Shiba Studio…`}</p>
  </div>
  <script>
    (function () {
      var ok = ${ok ? 'true' : 'false'};
      var target = ${JSON.stringify(target)};
      var appOrigin = ${JSON.stringify(appOrigin)};
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(ok ? 'shiba-oauth:connected' : 'shiba-oauth:error', appOrigin); } catch (e) {}
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
  const current = g.__shibaOAuthLoopback;
  if (!current) return;
  clearTimeout(current.expiry);
  try { current.server.close(); } catch { /* already closed */ }
  g.__shibaOAuthLoopback = undefined;
}

/** Bind 127.0.0.1 on a random free port and wait for the OAuth redirect. */
export async function startOAuthLoopback(appOrigin: string): Promise<{ port: number; redirectUri: string }> {
  stopOAuthLoopback(); // a fresh sign-in gets a fresh listener

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || undefined;

      let page: string;
      if (error) {
        page = buildHandbackHtml('error', appOrigin, url.searchParams.get('error_description') || error);
      } else if (!code) {
        page = buildHandbackHtml('error', appOrigin, 'Missing authorization code');
      } else {
        try {
          const { exchangeOAuthCode } = await import('./xai-oauth');
          await exchangeOAuthCode(code, state);
          page = buildHandbackHtml('connected', appOrigin);
        } catch (e: unknown) {
          page = buildHandbackHtml('error', appOrigin, e instanceof Error ? e.message : 'OAuth exchange failed');
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      // The redirect only comes once — free the port shortly after replying.
      setTimeout(() => stopOAuthLoopback(), 3000);
    } catch {
      try { res.writeHead(500).end(); } catch { /* socket gone */ }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref(); // never hold the process open

  const port = (server.address() as AddressInfo).port;
  const expiry = setTimeout(() => stopOAuthLoopback(), 5 * 60_000); // abandoned sign-in
  expiry.unref();
  g.__shibaOAuthLoopback = { server, port, expiry };

  return { port, redirectUri: `http://127.0.0.1:${port}/callback` };
}
