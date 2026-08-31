import { NextRequest, NextResponse } from 'next/server';
import { exchangeGoogleCode, parseGoogleOAuthService } from '@/lib/google-oauth';
import { buildHandbackHtml, type OAuthHandbackChannel } from '@/lib/oauth-loopback';
import { publicOriginForRequestHost } from '@/lib/public-origin';

/**
 * Google redirects the sign-in popup here after consent. We exchange the code
 * for tokens (stored encrypted), then render the shared self-closing hand-back
 * page so the app flips Drive or Gmail to Connected and the popup closes.
 */
function appOrigin(req: NextRequest): string {
  return publicOriginForRequestHost(req.headers.get('host') || req.nextUrl.host)?.origin
    || req.nextUrl.origin;
}

function page(req: NextRequest, kind: 'connected' | 'error', channel: OAuthHandbackChannel, message?: string): NextResponse {
  return new NextResponse(buildHandbackHtml(kind, appOrigin(req), message, channel), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');
  const service = parseGoogleOAuthService(req.nextUrl.searchParams.get('state'));
  const channel: OAuthHandbackChannel = service === 'gmail'
    ? 'shiba-gmail'
    : service === 'youtube'
      ? 'shiba-youtube'
      : 'shiba-drive';

  if (error) {
    // Surface Google's own reason with an actionable hint for the common one.
    let msg = errorDescription || error;
    if (/redirect_uri_mismatch/i.test(msg)) {
      msg += ` — add "${appOrigin(req)}/api/google-oauth/callback" to your OAuth client's Authorized redirect URIs (or use a "Desktop app" client).`;
    }
    return page(req, 'error', channel, msg);
  }
  if (!code) {
    return page(req, 'error', channel, 'Missing authorization code');
  }

  try {
    await exchangeGoogleCode(code, appOrigin(req), service);
    return page(req, 'connected', channel);
  } catch (e: unknown) {
    return page(req, 'error', channel, e instanceof Error ? e.message : 'Google token exchange failed');
  }
}
