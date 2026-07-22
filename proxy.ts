import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { advertisedHostnames } from './lib/mdns';
import { publicOriginForRequestHost } from './lib/public-origin';

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

function canonicalHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function allowedRequestHostnames(): Set<string> {
  const allowed = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...advertisedHostnames(),
  ].map(canonicalHostname));
  const configuredLanIp = process.env.SHIBA_LAN_IP?.trim();
  if (configuredLanIp) allowed.add(canonicalHostname(configuredLanIp));
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (!entry.internal && entry.address) allowed.add(canonicalHostname(entry.address));
    }
  }
  return allowed;
}

/** Browser-visible origin after validating Host against names owned by Studio. */
function visibleRequestOrigin(req: NextRequest): string | null {
  const rawHost = (req.headers.get('host') || req.nextUrl.host).trim();
  if (!rawHost || /[\s\\/@?#%]/.test(rawHost)) return null;

  // A reverse proxy must preserve the exact browser-visible Host. Its scheme
  // comes from the operator-owned setting, never X-Forwarded-* supplied by a
  // client. Local/mDNS/LAN origins continue through the existing path below.
  const publicOrigin = publicOriginForRequestHost(rawHost);
  if (publicOrigin) return publicOrigin.origin;

  let protocol = req.nextUrl.protocol.toLowerCase();
  if (hasTrustedLanProxySecret(req)) {
    const forwarded = (req.headers.get('x-forwarded-proto') || '').toLowerCase();
    if (forwarded !== 'http' && forwarded !== 'https') return null;
    protocol = `${forwarded}:`;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  try {
    const authority = new URL(`${protocol}//${rawHost}`);
    if (!allowedRequestHostnames().has(canonicalHostname(authority.hostname))) return null;
    return authority.origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string, requestOrigin: string): boolean {
  try {
    return new URL(origin).origin === requestOrigin;
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

function isTrustedLanStudioClient(req: NextRequest): boolean {
  return process.env.SHIBA_LAN === '1'
    && process.env.SHIBA_LAN_STUDIO === '1'
    && hasTrustedLanProxySecret(req)
    && req.headers.get(CLIENT_CLASS_HEADER) === 'studio';
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
  const requestOrigin = visibleRequestOrigin(req);
  if (!requestOrigin) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'Unrecognized Shiba Studio host.' }, { status: 421 });
    }
    return new NextResponse('Unrecognized Shiba Studio host.', { status: 421 });
  }
  const lanCompanionBoundary = isRemoteLanClient(req) && !isTrustedLanStudioClient(req);

  // Regular LAN/Tailscale exposure is a scoped companion surface. Only the
  // explicit Studio mode promotes a private socket peer; public or untrusted
  // peers still reach just the companion page and authenticated scoped API,
  // even if they send `Host: localhost`.
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
  if (origin && !isAllowedOrigin(origin, requestOrigin)) {
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
