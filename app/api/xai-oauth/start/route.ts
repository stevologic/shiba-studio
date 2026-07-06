import { NextRequest, NextResponse } from 'next/server';
import { startOAuthFlow } from '@/lib/xai-oauth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const origin = typeof body.origin === 'string' ? body.origin : req.nextUrl.origin;
    const started = await startOAuthFlow(origin);
    return NextResponse.json({
      ok: true,
      authorizeUrl: started.authorizeUrl,
      state: started.state,
      redirectUri: started.redirectUri,
      loginHost: 'https://accounts.x.ai',
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to start OAuth';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}