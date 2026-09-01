import { NextRequest, NextResponse } from 'next/server';
import { parseGoogleOAuthService, startGoogleOAuth } from '@/lib/google-oauth';
import { publicOriginForRequestHost } from '@/lib/public-origin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const publicOrigin = publicOriginForRequestHost(req.headers.get('host') || req.nextUrl.host);
    const origin = publicOrigin?.origin
      || (typeof body.origin === 'string' ? body.origin : req.nextUrl.origin);
    const service = parseGoogleOAuthService(typeof body.service === 'string' ? body.service : 'drive');
    const { authorizeUrl, redirectUri } = await startGoogleOAuth(origin, service);
    return NextResponse.json({ ok: true, authorizeUrl, redirectUri, service });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to start Google sign-in' },
      { status: 400 },
    );
  }
}
