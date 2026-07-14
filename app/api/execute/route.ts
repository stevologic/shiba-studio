import { NextRequest, NextResponse } from 'next/server';
import { loadAgents } from '@/lib/persistence';
import { runAgentOnce } from '@/lib/agent-runtime';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { agentId, prompt } = body;
  if (!agentId || !prompt) return NextResponse.json({ error: 'agentId + prompt required' }, { status: 400 });
  if (['scheduled', 'scheduleId', 'scheduleInstructions'].some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    return NextResponse.json({ error: 'Scheduled provenance is internal to Automations. Run an Automation through /api/routines.' }, { status: 400 });
  }

  const agents = await loadAgents();
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return NextResponse.json({ error: 'agent not found' }, { status: 404 });

  try {
    const run = await runAgentOnce(agent, prompt, { signal: req.signal });
    return NextResponse.json({ run });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
