import { NextRequest, NextResponse } from 'next/server';
import { exchangeOAuthCode, getOAuthPublicStatus, parseOAuthCallbackInput } from '@/lib/xai-oauth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let code = typeof body.code === 'string' ? body.code.trim() : '';
    let state = typeof body.state === 'string' ? body.state.trim() : undefined;

    if (!code && typeof body.callback === 'string') {
      const parsed = parseOAuthCallbackInput(body.callback);
      code = parsed.code;
      state = parsed.state || state;
    }

    if (!code) {
      return NextResponse.json({ ok: false, error: 'Missing authorization code' }, { status: 400 });
    }

    await exchangeOAuthCode(code, state);
    const status = await getOAuthPublicStatus();
    const { audit } = await import('@/lib/audit-log');
    audit('auth', 'oauth connected', 'Signed in with X (accounts.x.ai)');
    return NextResponse.json({ ok: true, status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'OAuth exchange failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}