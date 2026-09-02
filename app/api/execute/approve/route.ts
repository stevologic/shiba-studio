import { NextRequest, NextResponse } from 'next/server';
import {
  canAlwaysApproveTool,
  getPendingApproval,
  rememberAlwaysApprovedTool,
  resolveToolApproval,
} from '@/lib/tool-approval';

export async function POST(req: NextRequest) {
  const { approvalId, approved, always } = await req.json();
  if (!approvalId) {
    return NextResponse.json({ error: 'approvalId required' }, { status: 400 });
  }
  const pending = getPendingApproval(String(approvalId));
  if (!pending) {
    return NextResponse.json({ error: 'Approval not found or already resolved' }, { status: 404 });
  }
  const remember = !!always;
  if (remember && !canAlwaysApproveTool(pending.toolName)) {
    return NextResponse.json({ error: 'This tool cannot be always approved' }, { status: 400 });
  }
  if (remember) {
    await rememberAlwaysApprovedTool(pending.toolName, pending.agentId);
  }
  const ok = resolveToolApproval(String(approvalId), remember || !!approved);
  if (!ok) {
    return NextResponse.json({ error: 'Approval not found or already resolved' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, approved: remember || !!approved, always: remember });
}