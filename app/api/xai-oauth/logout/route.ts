import { NextResponse } from 'next/server';
import { clearOAuthSession } from '@/lib/xai-oauth';

export async function POST() {
  await clearOAuthSession();
  const { audit } = await import('@/lib/audit-log');
  audit('auth', 'oauth disconnected');
  return NextResponse.json({ ok: true, connected: false });
}