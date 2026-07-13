import { NextRequest, NextResponse } from 'next/server';
import { globalSearch } from '@/lib/global-search';

/** GET /api/search?q= → hits across chats, memories, runs, and the audit log. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  const hits = await globalSearch(q);
  return NextResponse.json({ ok: true, q, hits });
}
