import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, mutateAgents, loadConfig } from '@/lib/persistence';
import { Agent, normalizeAgent, EMPTY_INTEGRATION_SCOPE } from '@/lib/types';
import { defaultAvatarIdForAgent, isValidAvatarId } from '@/lib/agent-avatars';
import { v4 as uuidv4 } from 'uuid';
import { audit } from '@/lib/audit-log';
import { maskIntegrationCreds, restoreMaskedCreds } from '@/lib/secret-mask';
import { redditOverridePairError } from '@/lib/integration-validation';

function clientSafeAgent(agent: Agent): Agent {
  const safe = {
    ...agent,
    ...(agent.integrationOverrides ? { integrationOverrides: maskIntegrationCreds(agent.integrationOverrides) } : {}),
  } as Agent & Record<string, unknown>;
  delete safe.schedules;
  delete safe.schedule;
  return safe;
}

function withoutRetiredScheduleFields(value: unknown): Partial<Agent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = { ...(value as Record<string, unknown>) };
  delete clean.schedules;
  delete clean.schedule;
  return clean as Partial<Agent>;
}

function hasRetiredScheduleFields(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (
    Object.prototype.hasOwnProperty.call(value, 'schedules')
    || Object.prototype.hasOwnProperty.call(value, 'schedule')
  ));
}

async function ensureLegacySchedulesMigrated(): Promise<void> {
  const { migrateLegacyAgentSchedules } = await import('@/lib/routines');
  await migrateLegacyAgentSchedules();
}

export async function GET() {
  let raw = await loadAgents();
  const { migrateLegacyAgentSchedules } = await import('@/lib/routines');
  const migration = await migrateLegacyAgentSchedules(raw);
  if (migration.agents > 0) raw = await loadAgents();
  const agents = raw.map(normalizeAgent).map(clientSafeAgent);
  return NextResponse.json({ agents });
}

export async function POST(req: NextRequest) {
  await ensureLegacySchedulesMigrated();
  const body = await req.json();

  if (body.action === 'delete') {
    const { withIntegrityMutation } = await import('@/lib/integrity-coordinator');
    const { result: removed } = await withIntegrityMutation(
      `agent deletion:${String(body.id || '')}`,
      () => mutateAgents(async (agents) => {
        const idx = agents.findIndex((agent) => agent.id === body.id);
        if (idx < 0) return null;
        const removedAgent = agents.splice(idx, 1)[0];
        if (removedAgent.workspace?.useWorktree && removedAgent.workspace.path) {
          const { requestWorktreeResourceDeletion } = await import('@/lib/worktree-integrity');
          await requestWorktreeResourceDeletion(
            removedAgent.workspace.path,
            removedAgent.id,
            'Agent was deleted.',
          );
        }
        return removedAgent;
      }),
      { includeWorktrees: true, includeExternalCleanup: false },
    );
    if (!removed) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
    // Reconcile durable references, then make the first sandbox cleanup attempt
    // inline. Periodic inventory retries Docker
    // cleanup if the daemon is temporarily unavailable.
    const { removeSandbox } = await import('@/lib/agent-sandbox');
    const sandboxCleanup = await removeSandbox(removed.id)
      .catch(() => ({ ok: false, removed: false }));
    audit('agent', 'agent deleted', removed.name, {
      agentId: removed.id,
      sandboxCleanup: sandboxCleanup.ok ? (sandboxCleanup.removed ? 'removed' : 'not_present') : 'retry_pending',
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'update') {
    if (hasRetiredScheduleFields(body.agent)) {
      return NextResponse.json({ error: 'Agent schedules were retired. Create or update an Automation through /api/routines.' }, { status: 400 });
    }
    const overrideError = redditOverridePairError(body.agent?.integrationOverrides);
    if (overrideError) return NextResponse.json({ error: overrideError }, { status: 400 });
    const incomingAgent = withoutRetiredScheduleFields(body.agent);
    const { withIntegrityMutation } = await import('@/lib/integrity-coordinator');
    const { result: updated } = await withIntegrityMutation(
      `agent update:${String(body.agent?.id || '')}`,
      () => mutateAgents(async (agents) => {
        const idx = agents.findIndex(a => a.id === body.agent.id);
        if (idx === -1) return null;
        const previousWorkspace = agents[idx].workspace;
        const incoming = incomingAgent.integrationOverrides && typeof incomingAgent.integrationOverrides === 'object'
          ? restoreMaskedCreds(incomingAgent.integrationOverrides, agents[idx].integrationOverrides || {})
          : incomingAgent.integrationOverrides;
        const merged = {
          ...agents[idx],
          ...incomingAgent,
          ...(incoming !== undefined ? { integrationOverrides: incoming } : {}),
          updatedAt: new Date().toISOString(),
        };
        if (merged.avatar && !isValidAvatarId(merged.avatar)) delete merged.avatar;
        const normalized = normalizeAgent(merged);
        const oldPath = previousWorkspace?.path?.trim() || '';
        const newPath = normalized.workspace?.path?.trim() || '';
        if (previousWorkspace?.useWorktree && oldPath
          && (!normalized.workspace.useWorktree || oldPath !== newPath)) {
          const { requestWorktreeResourceDeletion } = await import('@/lib/worktree-integrity');
          await requestWorktreeResourceDeletion(oldPath, normalized.id, 'Agent worktree mapping changed.');
        }
        agents[idx] = normalized;
        return normalized;
      }),
      { includeWorktrees: true, includeExternalCleanup: false },
    );
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    audit('agent', 'agent updated', updated.name, { agentId: updated.id });
    return NextResponse.json({ agent: clientSafeAgent(updated) });
  }

  const now = new Date().toISOString();
  if (hasRetiredScheduleFields(body)) {
    return NextResponse.json({ error: 'Agent schedules were retired. Create the agent first, then add an Automation through /api/routines.' }, { status: 400 });
  }
  const overrideError = redditOverridePairError(body.integrationOverrides);
  if (overrideError) return NextResponse.json({ error: overrideError }, { status: 400 });
  const cfg = await loadConfig();
  const newId = uuidv4();
  const newAgent: Agent = {
    id: newId,
    name: body.name || 'New Agent',
    avatar: body.avatar && isValidAvatarId(body.avatar) ? body.avatar : defaultAvatarIdForAgent(newId),
    model: typeof body.model === 'string' && body.model ? body.model : (cfg.defaultGrokModel || 'grok-4'),
    description: body.description || '',
    autoAcceptBoardAssignments: body.autoAcceptBoardAssignments === true,
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
    createdAt: now,
    updatedAt: now,
  };
  await mutateAgents((agents) => {
    agents.push(newAgent);
  });
  audit('agent', 'agent created', newAgent.name, { agentId: newAgent.id, model: newAgent.model });
  return NextResponse.json({ agent: clientSafeAgent(normalizeAgent(newAgent)) });
}
