import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, mutateAgents, loadConfig } from '@/lib/persistence';
import { Agent, normalizeAgent, EMPTY_INTEGRATION_SCOPE } from '@/lib/types';
import { defaultAvatarIdForAgent, isValidAvatarId } from '@/lib/agent-avatars';
import { v4 as uuidv4 } from 'uuid';
import { automationCronError, loadAndScheduleAll } from '@/lib/scheduler';
import { audit } from '@/lib/audit-log';
import { maskIntegrationCreds, restoreMaskedCreds } from '@/lib/secret-mask';

function clientSafeAgent(agent: Agent): Agent {
  return agent.integrationOverrides
    ? { ...agent, integrationOverrides: maskIntegrationCreds(agent.integrationOverrides) }
    : agent;
}

function scheduleValidationError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { schedules?: Array<{ cron?: unknown }>; schedule?: { cron?: unknown } };
  const expressions = [
    ...(Array.isArray(candidate.schedules) ? candidate.schedules.map((entry) => entry?.cron) : []),
    ...(candidate.schedule?.cron !== undefined ? [candidate.schedule.cron] : []),
  ];
  for (const expression of expressions) {
    const error = automationCronError(expression);
    if (error) return error;
  }
  return null;
}

export async function GET() {
  const raw = await loadAgents();
  const agents = raw.map(normalizeAgent).map(clientSafeAgent);
  return NextResponse.json({ agents });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === 'delete') {
    const { withIntegrityMutation } = await import('@/lib/integrity-coordinator');
    const { result: removed } = await withIntegrityMutation(`agent deletion:${String(body.id || '')}`, () => (
      mutateAgents((agents) => {
        const idx = agents.findIndex((agent) => agent.id === body.id);
        if (idx < 0) return null;
        return agents.splice(idx, 1)[0];
      })
    ));
    if (!removed) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
    if (removed.workspace?.useWorktree && removed.workspace.path) {
      const { requestWorktreeResourceDeletion } = await import('@/lib/worktree-integrity');
      const registered = await requestWorktreeResourceDeletion(
        removed.workspace.path,
        removed.id,
        'Agent was deleted.',
      ).then(() => true).catch((error) => {
        console.error('[shiba-studio] deferred deleted-agent worktree cleanup', error);
        return false;
      });
      if (registered) {
        const { reconcileWorktreeResources } = await import('@/lib/worktree-integrity');
        await reconcileWorktreeResources({ agents: await loadAgents() }).catch((error) => {
          console.error('[shiba-studio] deleted-agent worktree cleanup will be retried', error);
        });
      }
    }
    // Reconcile durable references before schedules are rearmed, then make the
    // first sandbox cleanup attempt inline. Periodic inventory retries Docker
    // cleanup if the daemon is temporarily unavailable.
    const { removeSandbox } = await import('@/lib/agent-sandbox');
    const sandboxCleanup = await removeSandbox(removed.id)
      .catch(() => ({ ok: false, removed: false }));
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent deleted', removed.name, {
      agentId: removed.id,
      sandboxCleanup: sandboxCleanup.ok ? (sandboxCleanup.removed ? 'removed' : 'not_present') : 'retry_pending',
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'update') {
    const validationError = scheduleValidationError(body.agent);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
    const updated = await mutateAgents((agents) => {
      const idx = agents.findIndex(a => a.id === body.agent.id);
      if (idx === -1) return null;
      const incoming = body.agent?.integrationOverrides && typeof body.agent.integrationOverrides === 'object'
        ? restoreMaskedCreds(body.agent.integrationOverrides, agents[idx].integrationOverrides || {})
        : body.agent?.integrationOverrides;
      const merged = {
        ...agents[idx],
        ...body.agent,
        ...(incoming !== undefined ? { integrationOverrides: incoming } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (merged.avatar && !isValidAvatarId(merged.avatar)) delete merged.avatar;
      agents[idx] = normalizeAgent(merged);
      return agents[idx];
    });
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    await loadAndScheduleAll().catch(() => {});
    audit('agent', 'agent updated', updated.name, { agentId: updated.id });
    return NextResponse.json({ agent: clientSafeAgent(updated) });
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
  const validationError = scheduleValidationError({ schedules: initSchedules });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
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
  return NextResponse.json({ agent: clientSafeAgent(normalizeAgent(newAgent)) });
}
