import { NextRequest, NextResponse } from 'next/server';
import { exchangeOAuthCode } from '@/lib/xai-oauth';
import { buildHandbackHtml } from '@/lib/oauth-loopback';
import { publicOriginForRequestHost } from '@/lib/public-origin';

/**
 * Legacy/manual-path callback on the app's own origin. The primary sign-in
 * flow redirects to the disposable 127.0.0.1 loopback listener instead (the
 * only redirect shape auth.x.ai registers for this client) — but this route
 * keeps old links and hand-crafted callbacks working, serving the same
 * self-closing hand-back page.
 */
function page(req: NextRequest, kind: 'connected' | 'error', message?: string): NextResponse {
  const origin = publicOriginForRequestHost(req.headers.get('host') || req.nextUrl.host)?.origin
    || req.nextUrl.origin;
  return new NextResponse(buildHandbackHtml(kind, origin, message), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || undefined;
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) {
    return page(req, 'error', errorDescription || error);
  }

  if (!code) {
    return page(req, 'error', 'Missing authorization code');
  }

  try {
    await exchangeOAuthCode(code, state);
    return page(req, 'connected');
  } catch (e: unknown) {
    return page(req, 'error', e instanceof Error ? e.message : 'OAuth exchange failed');
  }
}
