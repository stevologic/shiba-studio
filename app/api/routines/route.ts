import type { NextRequest } from 'next/server';
import { createRoutine, listRoutines } from '@/lib/routines';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const enabled = query.get('enabled');
    const result = listRoutines({
      ...(enabled == null ? {} : { enabled: enabled === 'true' }),
      limit: Number(query.get('limit')) || undefined,
      offset: Number(query.get('offset')) || undefined,
    });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid routine query' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const routine = createRoutine(body);
    return Response.json({ ok: true, routine }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid routine';
    return Response.json({ ok: false, error: message }, { status: /already exists/i.test(message) ? 409 : 400 });
  }
}
