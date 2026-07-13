import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, mutateAgents, loadConfig } from '@/lib/persistence';
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

  if (body.action === 'delete') {
    const removed = await mutateAgents((agents) => {
      const idx = agents.findIndex((agent) => agent.id === body.id);
      if (idx < 0) return null;
      return agents.splice(idx, 1)[0];
    });
    if (!removed) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
    const { clearMemories } = await import('@/lib/agent-memory');
    clearMemories({ agentId: removed.id });
    // The agent's sandbox container goes with it — fire-and-forget so a slow
    // (or absent) Docker daemon never delays the delete response.
    import('@/lib/agent-sandbox')
      .then(({ removeSandbox }) => removeSandbox(removed.id))
      .catch(() => {});
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent deleted', removed.name, { agentId: removed.id });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'update') {
    const updated = await mutateAgents((agents) => {
      const idx = agents.findIndex(a => a.id === body.agent.id);
      if (idx === -1) return null;
      const merged = { ...agents[idx], ...body.agent, updatedAt: new Date().toISOString() };
      if (merged.avatar && !isValidAvatarId(merged.avatar)) delete merged.avatar;
      agents[idx] = normalizeAgent(merged);
      return agents[idx];
    });
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent updated', updated.name, { agentId: updated.id });
    return NextResponse.json({ agent: updated });
  }

  // create (support skills[] and schedules[] or legacy schedule)
  const now = new Date().toISOString();
  const initSchedules = body.schedules && Array.isArray(body.schedules) && body.schedules.length > 0
    ? body.schedules.map((s: { id?: string; enabled?: boolean; cron?: string; instructions?: string; description?: string }, i: number) => ({
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
    model: typeof body.model === 'string' && body.model ? body.model : (cfg.defaultGrokModel || 'grok-4'),
    description: body.description || '',
    workspace: {
      path: body.workspace?.path || process.cwd(),
      useWorktree: !!body.workspace?.useWorktree,
    },
    integrations: { ...EMPTY_INTEGRATION_SCOPE, ...(body.integrations || {}) },
    integrationOverrides: body.integrationOverrides && typeof body.integrationOverrides === 'object' ? body.integrationOverrides : undefined,
    driveFolders: Array.isArray(body.driveFolders) ? body.driveFolders : [],
    peers: body.peers || [],
    skills: body.skills || [],
    chatSkill: body.chatSkill || '',
    voiceId: typeof body.voiceId === 'string' && body.voiceId.trim()
      ? body.voiceId.trim().toLowerCase()
      : undefined,
    learning: {
      mode: body.learning?.mode === 'auto' || body.learning?.mode === 'review' ? body.learning.mode : 'off',
      autoRecall: body.learning?.autoRecall !== false,
      maxMemories: Math.max(10, Math.min(500, Number(body.learning?.maxMemories) || 100)),
    },
    schedules: initSchedules,
    schedule: body.schedule, // legacy
    createdAt: now,
    updatedAt: now,
  };
  await mutateAgents((agents) => {
    agents.push(newAgent);
  });
  await loadAndScheduleAll().catch(() => {});
  audit('agent', 'agent created', newAgent.name, { agentId: newAgent.id, model: newAgent.model });
  return NextResponse.json({ agent: normalizeAgent(newAgent) });
}
