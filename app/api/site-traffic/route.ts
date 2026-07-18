import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import {
  getSiteTrafficSnapshot,
  SiteTrafficServiceError,
} from '@/lib/site-traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}

function publicError(error: unknown) {
  if (error instanceof SiteTrafficServiceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status);
  }
  console.error('[shiba-studio] Site traffic request failed', error);
  return json(
    {
      ok: false,
      error: 'The traffic monitor could not complete the request.',
      code: 'SITE_TRAFFIC_INTERNAL_ERROR',
    },
    500,
  );
}

export async function GET(req: NextRequest) {
  try {
    const config = await loadConfig();
    const snapshot = await getSiteTrafficSnapshot({
      refresh: req.nextUrl.searchParams.get('refresh') === '1',
      githubToken: config.integrations?.github?.token,
    });
    return json(snapshot);
  } catch (error) {
    return publicError(error);
  }
}
