import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, saveAgents, loadConfig } from '@/lib/persistence';
import { Agent, normalizeAgent, EMPTY_INTEGRATION_SCOPE } from '@/lib/types';
import { defaultAvatarIdForAgent, isValidAvatarId } from '@/lib/agent-avatars';
import { v4 as uuidv4 } from 'uuid';
import { loadAndScheduleAll } from '@/lib/scheduler';
import { audit } from '@/lib/audit-log';

export async function GET() {
  const raw = await loadAgents();
  const agents = raw.map(normalizeAgent);
  return NextResponse.json({ agents });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const agents = await loadAgents();

  if (body.action === 'delete') {
    const removed = agents.find(a => a.id === body.id);
    const filtered = agents.filter(a => a.id !== body.id);
    await saveAgents(filtered);
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent deleted', removed?.name || String(body.id), { agentId: body.id });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'update') {
    const idx = agents.findIndex(a => a.id === body.agent.id);
    if (idx === -1) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const merged = { ...agents[idx], ...body.agent, updatedAt: new Date().toISOString() };
    if (merged.avatar && !isValidAvatarId(merged.avatar)) delete merged.avatar;
    agents[idx] = normalizeAgent(merged);
    await saveAgents(agents);
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent updated', agents[idx].name, { agentId: agents[idx].id });
    return NextResponse.json({ agent: agents[idx] });
  }

  // create (support skills[] and schedules[] or legacy schedule)
  const now = new Date().toISOString();
  const initSchedules = body.schedules && Array.isArray(body.schedules) && body.schedules.length > 0 
    ? body.schedules.map((s: any, i: number) => ({
        id: s.id || `sch-${i}-${Date.now()}`,
        enabled: s.enabled !== false,
        cron: s.cron || '*/30 * * * *',
        instructions: s.instructions || s.description || body.description || 'Perform scheduled task.',
        description: s.description
      }))
    : (body.schedule ? [{
        id: 'init-schedule',
        enabled: body.schedule.enabled !== false,
        cron: body.schedule.cron || '*/30 * * * *',
        instructions: body.schedule.description || body.description || 'Perform scheduled task.',
        description: body.schedule.description
      }] : []);
  const cfg = await loadConfig();
  const newId = uuidv4();
  const newAgent: Agent = {
    id: newId,
    name: body.name || 'New Agent',
    avatar: body.avatar && isValidAvatarId(body.avatar) ? body.avatar : defaultAvatarIdForAgent(newId),
    origin: body.origin === 'cloud' ? 'cloud' : 'local',
    model: typeof body.model === 'string' && body.model ? body.model : (cfg.defaultGrokModel || 'grok-4'),
    description: body.description || '',
    workspace: {
      path: body.workspace?.path || process.cwd(),
      useWorktree: !!body.workspace?.useWorktree,
    },
    integrations: { ...EMPTY_INTEGRATION_SCOPE, ...(body.integrations || {}) },
    peers: body.peers || [],
    skills: body.skills || [],
    chatSkill: body.chatSkill || '',
    schedules: initSchedules,
    schedule: body.schedule, // legacy
    createdAt: now,
    updatedAt: now,
  };
  agents.push(newAgent);
  await saveAgents(agents);
  await loadAndScheduleAll().catch(() => {});
  audit('agent', 'agent created', newAgent.name, { agentId: newAgent.id, model: newAgent.model, origin: newAgent.origin });
  return NextResponse.json({ agent: normalizeAgent(newAgent) });
}
