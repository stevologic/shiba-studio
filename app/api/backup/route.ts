import { NextRequest, NextResponse } from 'next/server';
import { buildBackup, restoreBackup } from '@/lib/backup';

/** GET /api/backup → download the full studio backup as one JSON file.
 *  ?key=omit strips the machine encryption key from the bundle. */
export async function GET(req: NextRequest) {
  const includeKey = req.nextUrl.searchParams.get('key') !== 'omit';
  const bundle = await buildBackup({ includeKey });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(bundle), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="shiba-studio-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** POST /api/backup with a bundle (as body) → restore it. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be a Shiba Studio backup JSON file' }, { status: 400 });
  }
  const result = await restoreBackup(body);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
