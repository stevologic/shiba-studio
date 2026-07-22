import { NextRequest, NextResponse } from 'next/server';
import { exchangeGoogleDriveCode } from '@/lib/google-oauth';
import { buildHandbackHtml } from '@/lib/oauth-loopback';
import { publicOriginForRequestHost } from '@/lib/public-origin';

/**
 * Google redirects the sign-in popup here after consent. We exchange the code
 * for tokens (stored encrypted), then render the shared self-closing hand-back
 * page on the 'shiba-drive' channel so the app flips Google Drive to Connected
 * and the popup closes itself.
 */
function appOrigin(req: NextRequest): string {
  return publicOriginForRequestHost(req.headers.get('host') || req.nextUrl.host)?.origin
    || req.nextUrl.origin;
}

function page(req: NextRequest, kind: 'connected' | 'error', message?: string): NextResponse {
  return new NextResponse(buildHandbackHtml(kind, appOrigin(req), message, 'shiba-drive'), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) {
    // Surface Google's own reason with an actionable hint for the common one.
    let msg = errorDescription || error;
    if (/redirect_uri_mismatch/i.test(msg)) {
      msg += ` — add "${appOrigin(req)}/api/google-oauth/callback" to your OAuth client's Authorized redirect URIs (or use a "Desktop app" client).`;
    }
    return page(req, 'error', msg);
  }
  if (!code) {
    return page(req, 'error', 'Missing authorization code');
  }

  try {
    await exchangeGoogleDriveCode(code, appOrigin(req));
    return page(req, 'connected');
  } catch (e: unknown) {
    return page(req, 'error', e instanceof Error ? e.message : 'Google token exchange failed');
  }
}
