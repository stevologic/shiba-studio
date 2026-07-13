import { NextRequest, NextResponse } from 'next/server';
import { startRedditOAuth } from '@/lib/reddit-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const origin = typeof body.origin === 'string' ? body.origin : req.nextUrl.origin;
    // Do not let a caller choose an unrelated hand-back/open-redirect origin.
    if (new URL(origin).origin !== req.nextUrl.origin) {
      return NextResponse.json(
        { ok: false, error: 'OAuth origin did not match this Shiba Studio instance' },
        { status: 400, headers: NO_STORE },
      );
    }
    const started = await startRedditOAuth(origin);
    return NextResponse.json({ ok: true, ...started }, { headers: NO_STORE });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to start Reddit sign-in' },
      { status: 400, headers: NO_STORE },
    );
  }
}
