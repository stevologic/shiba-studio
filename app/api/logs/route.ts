import { NextRequest, NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/audit-log';

const EXPORT_CAP = 10_000;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category') || undefined;
    const format = searchParams.get('format');

    // Export the full (filtered) trail as a downloadable file.
    if (format === 'csv' || format === 'json') {
      const { entries } = listAuditLogs({ limit: EXPORT_CAP, offset: 0, category });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suffix = category ? `-${category}` : '';
      if (format === 'json') {
        return new NextResponse(JSON.stringify(entries, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="grokdesk-logs${suffix}-${stamp}.json"`,
          },
        });
      }
      const rows = [
        'timestamp,category,action,detail,meta',
        ...entries.map((e) =>
          [
            e.ts,
            e.category,
            e.action,
            e.detail || '',
            e.meta ? JSON.stringify(e.meta) : '',
          ].map((v) => csvEscape(String(v))).join(','),
        ),
      ];
      return new NextResponse(rows.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="grokdesk-logs${suffix}-${stamp}.csv"`,
        },
      });
    }

    const result = listAuditLogs({
      limit: Number(searchParams.get('limit')) || 100,
      offset: Number(searchParams.get('offset')) || 0,
      category,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load logs';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
