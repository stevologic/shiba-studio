import { NextResponse } from 'next/server';
import { getContextSource } from '@/lib/context-engine';

type Params = { sourceId: string };

export async function GET(_req: Request, context: { params: Promise<Params> }) {
  try {
    const { sourceId } = await context.params;
    return NextResponse.json({ ok: true, ...getContextSource(decodeURIComponent(sourceId || '')) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Context source lookup failed';
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
