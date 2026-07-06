import { NextRequest, NextResponse } from 'next/server';
import { discardWorkspacePaths, getWorkspaceDiff } from '@/lib/workspace-diff';

export async function GET(req: NextRequest) {
  const dir = req.nextUrl.searchParams.get('dir') || '';
  if (!dir.trim()) {
    return NextResponse.json({ error: 'dir query param required' }, { status: 400 });
  }
  try {
    const result = await getWorkspaceDiff(dir);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load diff';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.action !== 'discard') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
  const dir = String(body.dir || '').trim();
  const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
  if (!dir) return NextResponse.json({ error: 'dir required' }, { status: 400 });
  try {
    const result = await discardWorkspacePaths(dir, paths);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    const refreshed = await getWorkspaceDiff(dir);
    return NextResponse.json({ ok: true, ...refreshed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Discard failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}