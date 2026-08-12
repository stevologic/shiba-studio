import type { NextRequest } from 'next/server';
import {
  listStudioAlerts,
  markAllStudioAlertsRead,
  markStudioAlertRead,
} from '@/lib/studio-alerts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unreadOnly = request.nextUrl.searchParams.get('unread') === '1';
  const limitRaw = request.nextUrl.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isSafeInteger(limit) || Number(limit) < 1)) {
    return Response.json({ ok: false, error: 'limit must be a positive integer' }, { status: 400 });
  }
  return Response.json({ ok: true, ...listStudioAlerts({ unreadOnly, limit }) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action?: string; id?: string };
    if (body.action === 'read-all') {
      return Response.json({ ok: true, marked: markAllStudioAlertsRead() });
    }
    if (body.action === 'read') {
      const alert = markStudioAlertRead(String(body.id || ''));
      if (!alert) return Response.json({ ok: false, error: 'Alert not found' }, { status: 404 });
      return Response.json({ ok: true, alert });
    }
    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not update alerts',
    }, { status: 400 });
  }
}
