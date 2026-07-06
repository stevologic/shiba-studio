import { NextRequest, NextResponse } from 'next/server';
import { loadRuns } from '@/lib/agent-runs-store';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId') || undefined;
  const runs = await loadRuns(agentId);
  return NextResponse.json({ runs });
}
