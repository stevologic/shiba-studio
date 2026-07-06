import { NextRequest, NextResponse } from 'next/server';
import { exchangeOAuthCode } from '@/lib/xai-oauth';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || undefined;
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) {
    const msg = errorDescription || error;
    return NextResponse.redirect(new URL(`/settings?oauth=error&message=${encodeURIComponent(msg)}`, req.nextUrl.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/settings?oauth=error&message=Missing%20authorization%20code', req.nextUrl.origin));
  }

  try {
    await exchangeOAuthCode(code, state);
    return NextResponse.redirect(new URL('/settings?oauth=connected', req.nextUrl.origin));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'OAuth exchange failed';
    return NextResponse.redirect(new URL(`/settings?oauth=error&message=${encodeURIComponent(msg)}`, req.nextUrl.origin));
  }
}