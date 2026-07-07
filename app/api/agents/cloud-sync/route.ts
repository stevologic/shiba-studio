import { NextResponse } from 'next/server';
import { loadAgents, saveAgents } from '@/lib/persistence';
import { listGrokModels } from '@/lib/grok-client';
import { encodeModelRef } from '@/lib/model-providers';
import { normalizeAgent, EMPTY_INTEGRATION_SCOPE, type Agent } from '@/lib/types';
import { defaultAvatarIdForAgent } from '@/lib/agent-avatars';

/**
 * Sync Grok cloud agents into the local Agents section.
 * Heavy / super-heavy Grok models on the account become cloud agents (origin: 'cloud'),
 * clearly marked as running in the Grok cloud rather than on this machine.
 */

function cloudAgentId(modelId: string): string {
  return `cloud-agent-${modelId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`;
}

function displayName(modelId: string): string {
  const pretty = modelId
    .replace(/-latest$/i, '')
    .split('-')
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
  return `${pretty} — Cloud Agent`;
}

export async function POST() {
  const listed = await listGrokModels();
  if (!listed.ok) {
    return NextResponse.json(
      { ok: false, error: listed.error || 'Could not reach the xAI model catalog — check cloud credentials.' },
      { status: 502 },
    );
  }

  // Prefer heavy/super-heavy tiers; fall back to the flagship grok-4 line so
  // every connected account can sync at least one cloud agent.
  const heavy = listed.models.filter((m) => /heavy|super/i.test(m.id));
  const flagship = listed.models
    .filter((m) => /^grok-4/i.test(m.id) && !/fast|mini|vision|image/i.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 1);
  const source = heavy.length ? heavy : flagship;

  if (!source.length) {
    return NextResponse.json({
      ok: true,
      created: [],
      updated: [],
      message: 'No heavy or flagship Grok models available on this account yet.',
    });
  }

  const agents = await loadAgents();
  const now = new Date().toISOString();
  const created: string[] = [];
  const updated: string[] = [];

  for (const model of source) {
    const id = cloudAgentId(model.id);
    const modelRef = encodeModelRef('cloud', model.id);
    const name = displayName(model.id);
    const description = heavy.length
      ? `Synced from Grok cloud (${model.id}) — a super-heavy xAI agent. Runs in the Grok cloud with cloud services only; no local system access.`
      : `Synced from Grok cloud (${model.id}) — flagship xAI cloud agent. Runs in the Grok cloud with cloud services only; no local system access.`;
    const existing = agents.find((a) => a.id === id);

    if (existing) {
      existing.model = modelRef;
      existing.origin = 'cloud';
      existing.name = name;
      existing.description = description;
      existing.updatedAt = now;
      updated.push(name);
    } else {
      const agent: Agent = normalizeAgent({
        id,
        name,
        avatar: defaultAvatarIdForAgent(id),
        origin: 'cloud',
        model: modelRef,
        description,
        workspace: { path: '', useWorktree: false },
        integrations: { ...EMPTY_INTEGRATION_SCOPE },
        peers: [],
        skills: ['research', 'analysis'],
        chatSkill: '',
        schedules: [],
        createdAt: now,
        updatedAt: now,
      });
      agents.push(agent);
      created.push(name);
    }
  }

  await saveAgents(agents);
  const { audit } = await import('@/lib/audit-log');
  audit('agent', 'cloud agents synced', `${created.length} added, ${updated.length} refreshed`);
  return NextResponse.json({
    ok: true,
    created,
    updated,
    message: `${created.length} cloud agent(s) added, ${updated.length} refreshed from Grok cloud.`,
  });
}
