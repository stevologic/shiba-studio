import { NextResponse } from 'next/server';
import { disconnectOAuth } from '@/lib/xai-oauth';

export async function POST() {
  await disconnectOAuth();
  const { audit } = await import('@/lib/audit-log');
  audit('auth', 'oauth disconnected');
  return NextResponse.json({ ok: true, connected: false });
}
