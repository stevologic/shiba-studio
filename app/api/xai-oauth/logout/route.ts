import { NextResponse } from 'next/server';
import { clearOAuthSession } from '@/lib/xai-oauth';

export async function POST() {
  await clearOAuthSession();
  return NextResponse.json({ ok: true, connected: false });
}