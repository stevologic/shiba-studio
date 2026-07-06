import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, saveAgents } from '@/lib/persistence';
import { updateAgentSchedule } from '@/lib/scheduler';

export async function POST(req: NextRequest) {
  const { agentId, cron, enabled } = await req.json();
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  await updateAgentSchedule(agentId, cron || '*/30 * * * *', !!enabled);
  const agents = await loadAgents();
  return NextResponse.json({ ok: true, agent: agents.find(a => a.id === agentId) });
}
