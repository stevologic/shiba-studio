import { NextResponse } from 'next/server';
import { getRedditOAuthStatus } from '@/lib/reddit-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getRedditOAuthStatus();
  return NextResponse.json(
    { ok: true, ...status },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
