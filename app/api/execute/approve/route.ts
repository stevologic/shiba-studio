import { NextRequest, NextResponse } from 'next/server';
import { resolveToolApproval } from '@/lib/tool-approval';

export async function POST(req: NextRequest) {
  const { approvalId, approved } = await req.json();
  if (!approvalId) {
    return NextResponse.json({ error: 'approvalId required' }, { status: 400 });
  }
  const ok = resolveToolApproval(String(approvalId), !!approved);
  if (!ok) {
    return NextResponse.json({ error: 'Approval not found or already resolved' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, approved: !!approved });
}