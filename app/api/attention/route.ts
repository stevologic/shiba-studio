import type { NextRequest } from 'next/server';
import { listAttention } from '@/lib/task-ledger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const result = listAttention({
      status: (query.get('status') || undefined) as 'open' | 'resolved' | 'dismissed' | undefined,
      taskId: query.get('taskId') || undefined,
      limit: Number(query.get('limit')) || undefined,
      offset: Number(query.get('offset')) || undefined,
    });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid attention query' }, { status: 400 });
  }
}
