import { NextRequest } from 'next/server';
import {
  CHAT_MEMORY_SCOPE,
  clearMemories,
  deleteMemory,
  listMemories,
  memoryStats,
  saveMemory,
  updateMemory,
  type MemorySource,
  type MemoryStatus,
} from '@/lib/agent-memory';
import { loadAgents } from '@/lib/persistence';
import { audit } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const status = params.get('status') || 'all';
  const source = params.get('source') || 'all';
  const agents = await loadAgents();
  const result = listMemories({
    agentId: params.get('agentId') || undefined,
    status: (status === 'active' || status === 'pending' || status === 'archived' ? status : 'all') as MemoryStatus | 'all',
    source: (source === 'manual' || source === 'tool' || source === 'learned' ? source : 'all') as MemorySource | 'all',
    query: params.get('q') || undefined,
    limit: Number(params.get('limit')) || 250,
    offset: Number(params.get('offset')) || 0,
  });
  return Response.json({
    ok: true,
    ...result,
    stats: memoryStats(),
    scopes: [
      { id: CHAT_MEMORY_SCOPE, label: 'Shared chat memory', kind: 'chat' },
      ...agents.map((agent) => ({ id: agent.id, label: agent.name, kind: 'agent' })),
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || 'create');

    if (action === 'create') {
      const result = saveMemory(
        String(body.agentId || CHAT_MEMORY_SCOPE),
        String(body.key || ''),
        String(body.content || ''),
        {
          kind: body.kind,
          status: body.status,
          source: 'manual',
          confidence: 1,
          pinned: !!body.pinned,
        },
      );
      audit('agent', 'memory created', result.entry.key, { memoryId: result.entry.id, scope: result.entry.agentId });
      return Response.json({ ok: true, entry: result.entry });
    }

    if (action === 'update') {
      const entry = updateMemory(Number(body.id), {
        ...(body.agentId !== undefined ? { agentId: String(body.agentId) } : {}),
        ...(body.key !== undefined ? { key: String(body.key) } : {}),
        ...(body.content !== undefined ? { content: String(body.content) } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.pinned !== undefined ? { pinned: !!body.pinned } : {}),
        ...(body.confidence !== undefined ? { confidence: Number(body.confidence) } : {}),
      });
      audit('agent', 'memory updated', entry.key, { memoryId: entry.id, scope: entry.agentId, status: entry.status });
      return Response.json({ ok: true, entry });
    }

    if (action === 'delete') {
      const id = Number(body.id);
      const removed = deleteMemory(id);
      if (removed) audit('agent', 'memory deleted', `memory ${id}`, { memoryId: id });
      return Response.json({ ok: true, removed });
    }

    if (action === 'clear') {
      const agentId = body.agentId ? String(body.agentId) : undefined;
      const status = body.status === 'active' || body.status === 'pending' || body.status === 'archived'
        ? body.status as MemoryStatus
        : undefined;
      const source = body.source === 'manual' || body.source === 'tool' || body.source === 'learned'
        ? body.source as MemorySource
        : undefined;
      const count = clearMemories({ agentId, status, source });
      audit('agent', 'memories cleared', `${count} removed`, { scope: agentId, status, source });
      return Response.json({ ok: true, count });
    }

    return Response.json({ ok: false, error: `Unknown memory action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Memory action failed' },
      { status: 400 },
    );
  }
}
