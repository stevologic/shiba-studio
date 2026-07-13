import { NextResponse } from 'next/server';
import { getNavStats } from '@/lib/nav-stats';
import { loadConfig } from '@/lib/persistence';

export async function GET() {
  const cfg = await loadConfig();
  const stats = await getNavStats(cfg);
  return NextResponse.json({ ok: true, ...stats });
}
