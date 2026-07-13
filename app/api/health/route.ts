import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Lightweight liveness target. It deliberately performs no startup work. */
export function GET() {
  return NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
