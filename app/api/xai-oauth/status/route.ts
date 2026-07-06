import { NextResponse } from 'next/server';
import { getOAuthPublicStatus } from '@/lib/xai-oauth';

export async function GET() {
  const status = await getOAuthPublicStatus();
  return NextResponse.json({ ok: true, ...status, connected: status.connected });
}