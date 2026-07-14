import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { advertisedHostnames } from './lib/mdns';

const CLIENT_CLASS_HEADER = 'x-shiba-client-class';
const PROXY_SECRET_HEADER = 'x-shiba-lan-proxy-secret';

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
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    // The app served from a non-loopback host (deliberate LAN exposure):
    // accept only the exact host:port the request itself was addressed to.
    if (u.host.toLowerCase() === req.nextUrl.host.toLowerCase()) return true;

    // Next normalizes a loopback-bound dev server's URL authority to localhost,
    // even when the browser reached it through the configured mDNS alias. In
    // that one case, compare against the preserved Host header. Restricting the
    // exception to an advertised name keeps forged and lookalike hosts denied.
    const requestHost = (req.headers.get('host') || '').trim().toLowerCase();
    return u.protocol === req.nextUrl.protocol
      && advertisedHostnames().includes(host)
      && requestHost === u.host.toLowerCase();
  } catch {
    return false; // includes literal "null" origins (sandboxed iframes)
  }
}

function hasTrustedLanProxySecret(req: NextRequest): boolean {
  const expected = process.env.SHIBA_LAN_PROXY_SECRET || '';
  const received = req.headers.get(PROXY_SECRET_HEADER) || '';
  if (!expected || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/**
 * The LAN launcher classifies the TCP peer before forwarding to the loopback-
 * only Next server. Missing/forged metadata fails closed as remote. Never use
 * request URL/Host/X-Forwarded-For for this decision: clients control them.
 */
function isRemoteLanClient(req: NextRequest): boolean {
  if (process.env.SHIBA_LAN !== '1') return false;
  return !hasTrustedLanProxySecret(req) || req.headers.get(CLIENT_CLASS_HEADER) !== 'local';
}

function continueWithoutLanBoundaryHeaders(req: NextRequest): NextResponse {
  if (process.env.SHIBA_LAN !== '1') return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_CLASS_HEADER);
  headers.delete(PROXY_SECRET_HEADER);
  return NextResponse.next({ request: { headers } });
}

function isTokenizedArtifactPublication(req: NextRequest, pathname: string): boolean {
  return (req.method === 'GET' || req.method === 'HEAD')
    && /^\/api\/artifact-public\/sha_[A-Za-z0-9_-]{43}$/.test(pathname);
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const lanCompanionBoundary = isRemoteLanClient(req);

  // LAN/Tailscale exposure is a companion surface, not generic remote Studio
  // access. A socket-classified loopback client retains the full app; a
  // network peer can reach only the companion page and separately authenticated
  // API, even if it sends `Host: localhost`.
  if (lanCompanionBoundary && !pathname.startsWith('/api/')) {
    if (pathname === '/companion' || (pathname.startsWith('/companion/') && !pathname.startsWith('/companion/admin'))) {
      return continueWithoutLanBoundaryHeaders(req);
    }
    return NextResponse.redirect(new URL('/companion', req.url));
  }

  if (!pathname.startsWith('/api/')) return continueWithoutLanBoundaryHeaders(req);

  if (
    lanCompanionBoundary
    && !pathname.startsWith('/api/companion/')
    && !pathname.startsWith('/api/native-nodes/')
    && !isTokenizedArtifactPublication(req, pathname)
  ) {
    return NextResponse.json(
      { ok: false, error: 'LAN clients may access only the scoped Companion API.' },
      { status: 403 },
    );
  }
  if (lanCompanionBoundary && pathname.startsWith('/api/companion/admin')) {
    return NextResponse.json({ ok: false, error: 'Companion administration is localhost-only.' }, { status: 403 });
  }
  if (lanCompanionBoundary && (pathname.startsWith('/api/native-nodes/admin') || pathname.startsWith('/api/native-nodes/captures'))) {
    return NextResponse.json({ ok: false, error: 'Native-node administration and captures are localhost-only.' }, { status: 403 });
  }

  // Optimistic auth check in Proxy; protected handlers always verify the hash,
  // expiry, revocation, and scope again at the data boundary.
  if (
    (pathname.startsWith('/api/companion/data') || pathname.startsWith('/api/companion/actions') || pathname.startsWith('/api/companion/voice'))
    && !/^Bearer\s+shiba_cmp_[A-Za-z0-9_-]{30,}$/i.test(req.headers.get('authorization') || '')
  ) {
    return NextResponse.json({ ok: false, error: 'A paired companion device key is required.' }, { status: 401 });
  }
  if (
    (pathname.startsWith('/api/native-nodes/poll') || pathname.startsWith('/api/native-nodes/complete') || pathname.startsWith('/api/native-nodes/events'))
    && !/^Bearer\s+shiba_node_[A-Za-z0-9_-]{30,}$/.test(req.headers.get('authorization') || '')
  ) {
    return NextResponse.json({ ok: false, error: 'A paired native-node key is required.' }, { status: 401 });
  }

  // Sign-in redirects arrive as cross-site top-level GETs; the callback's own
  // `state` parameter is the CSRF protection for these.
  if (req.method === 'GET' && OAUTH_CALLBACK_PATHS.has(pathname)) {
    return continueWithoutLanBoundaryHeaders(req);
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

  return continueWithoutLanBoundaryHeaders(req);
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|shiba-logo.svg|companion-sw.js).*)',
};
