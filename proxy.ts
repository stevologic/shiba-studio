import { NextRequest, NextResponse } from 'next/server';

/**
 * Same-origin guard for every API route (CSRF / drive-by protection).
 *
 * The API executes shell commands, writes files, and spends API credits, so a
 * malicious website open in the same browser must not be able to call it.
 * Browsers attach `Origin` to cross-origin fetches and `Sec-Fetch-Site:
 * cross-site` to cross-site navigations — both are rejected here. Non-browser
 * clients (curl, scripts) send neither header and stay allowed: they already
 * run with the user's local privileges and are not a cross-site vector.
 */

/** OAuth providers redirect the user's browser to these via top-level GET. */
const OAUTH_CALLBACK_PATHS = new Set([
  '/api/xai-oauth/callback',
  '/api/google-oauth/callback',
]);

function isAllowedOrigin(origin: string, req: NextRequest): boolean {
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    // The app served from a non-loopback host (deliberate LAN exposure):
    // accept only the exact host:port the request itself was addressed to.
    return u.host === req.nextUrl.host;
  } catch {
    return false; // includes literal "null" origins (sandboxed iframes)
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith('/api/')) return NextResponse.next();

  // Sign-in redirects arrive as cross-site top-level GETs; the callback's own
  // `state` parameter is the CSRF protection for these.
  if (req.method === 'GET' && OAUTH_CALLBACK_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const origin = req.headers.get('origin');
  if (origin && !isAllowedOrigin(origin, req)) {
    return NextResponse.json(
      { ok: false, error: 'Cross-origin requests to the Shiba Studio API are not allowed.' },
      { status: 403 },
    );
  }

  // Cross-site navigations/prefetches without an Origin header (e.g. a GET
  // link to an API URL from another site) — GETs here can still trigger model
  // spend or export data, so reject those too.
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (!origin && secFetchSite === 'cross-site') {
    return NextResponse.json(
      { ok: false, error: 'Cross-site requests to the Shiba Studio API are not allowed.' },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
