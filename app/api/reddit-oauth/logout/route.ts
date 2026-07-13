import { NextResponse } from 'next/server';
import { disconnectReddit } from '@/lib/reddit-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await disconnectReddit();
  const { audit } = await import('@/lib/audit-log');
  audit('auth', 'Reddit OAuth disconnected', result.warning || '');
  return NextResponse.json(
    { ok: true, connected: false, ...result },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
