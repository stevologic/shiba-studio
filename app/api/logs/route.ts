import { NextRequest, NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const result = listAuditLogs({
      limit: Number(searchParams.get('limit')) || 100,
      offset: Number(searchParams.get('offset')) || 0,
      category: searchParams.get('category') || undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load logs';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
