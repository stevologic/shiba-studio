import type { NextRequest } from 'next/server';
import { listAttention } from '@/lib/task-ledger';

export const dynamic = 'force-dynamic';

function readIntegerParam(value: string | null, name: string, minimum: number): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const result = listAttention({
      taskId: query.get('taskId') || undefined,
      limit: readIntegerParam(query.get('limit'), 'limit', 1),
      offset: readIntegerParam(query.get('offset'), 'offset', 0),
    });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid attention query' }, { status: 400 });
  }
}
