import { NextRequest, NextResponse } from 'next/server';
import { exchangeRedditCode } from '@/lib/reddit-oauth';
import { buildHandbackHtml, oauthHandbackHeaders } from '@/lib/oauth-loopback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function page(req: NextRequest, kind: 'connected' | 'error', message?: string): NextResponse {
  return new NextResponse(
    buildHandbackHtml(kind, req.nextUrl.origin, message, 'shiba-reddit'),
    { status: 200, headers: oauthHandbackHeaders() },
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || undefined;
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) return page(req, 'error', errorDescription || error);
  if (!code) return page(req, 'error', 'Missing Reddit authorization code');
  if (!state) return page(req, 'error', 'Missing Reddit OAuth state');

  try {
    const identity = await exchangeRedditCode(code, state, req.nextUrl.origin);
    const { audit } = await import('@/lib/audit-log');
    audit('auth', 'Reddit OAuth connected', identity.username ? `u/${identity.username}` : '');
    return page(req, 'connected');
  } catch (error: unknown) {
    return page(req, 'error', error instanceof Error ? error.message : 'Reddit token exchange failed');
  }
}
