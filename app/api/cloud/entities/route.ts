import { NextRequest, NextResponse } from 'next/server';
import { getSyncOverview, pullKind, pushKind, SYNC_KINDS, type SyncKind } from '@/lib/entity-sync';

export async function GET() {
  try {
    const overview = await getSyncOverview();
    return NextResponse.json({ ok: true, ...overview, kinds: SYNC_KINDS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load sync overview';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action as 'push' | 'pull';
    const kind = body.kind as SyncKind;
    if (!SYNC_KINDS.includes(kind)) {
      return NextResponse.json({ ok: false, error: `Unknown sync kind: ${kind}` }, { status: 400 });
    }
    if (action !== 'push' && action !== 'pull') {
      return NextResponse.json({ ok: false, error: 'action must be "push" or "pull"' }, { status: 400 });
    }
    const result = action === 'push' ? await pushKind(kind) : await pullKind(kind);
    return NextResponse.json({ ok: result.ok, result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
