import { NextRequest, NextResponse } from 'next/server';
import { exchangeOAuthCode } from '@/lib/xai-oauth';

/**
 * Lands here straight from accounts.x.ai. The token exchange already happened
 * server-side by the time this page renders, so the browser window's only job
 * is to hand control back gracefully:
 *  - opened as a popup (normal flow): tell the app it's connected via
 *    postMessage, then close itself — the user never touches anything.
 *  - opened in the same tab (popup was blocked): bounce back into the app.
 */
function callbackPage(kind: 'connected' | 'error', message?: string): NextResponse {
  const ok = kind === 'connected';
  const detail = (message || '').replace(/</g, '&lt;').slice(0, 300);
  const target = ok
    ? '/settings?oauth=connected'
    : `/settings?oauth=error&message=${encodeURIComponent(message || 'OAuth sign-in failed')}`;
  const html = `<!DOCTYPE html>
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
  code { color:#e5e5e5; }
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
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(ok ? 'shiba-oauth:connected' : 'shiba-oauth:error', window.location.origin); } catch (e) {}
        setTimeout(function () { window.close(); }, ok ? 1400 : 5000);
      } else {
        setTimeout(function () { window.location.replace(target); }, ok ? 900 : 2600);
      }
    })();
  </script>
</body>
</html>`;
  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || undefined;
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) {
    return callbackPage('error', errorDescription || error);
  }

  if (!code) {
    return callbackPage('error', 'Missing authorization code');
  }

  try {
    await exchangeOAuthCode(code, state);
    return callbackPage('connected');
  } catch (e: unknown) {
    return callbackPage('error', e instanceof Error ? e.message : 'OAuth exchange failed');
  }
}
