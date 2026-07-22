import { NextRequest, NextResponse } from 'next/server';
import { startGoogleDriveOAuth } from '@/lib/google-oauth';
import { publicOriginForRequestHost } from '@/lib/public-origin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const publicOrigin = publicOriginForRequestHost(req.headers.get('host') || req.nextUrl.host);
    const origin = publicOrigin?.origin
      || (typeof body.origin === 'string' ? body.origin : req.nextUrl.origin);
    const { authorizeUrl, redirectUri } = await startGoogleDriveOAuth(origin);
    return NextResponse.json({ ok: true, authorizeUrl, redirectUri });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to start Google sign-in' },
      { status: 400 },
    );
  }
}
