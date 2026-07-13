import { NextRequest, NextResponse } from 'next/server';
import { webFetch, webSearch } from '@/lib/agent-power-tools';
import {
  CHAT_MEMORY_SCOPE,
  deleteMemoryByKey,
  recallMemories,
  saveMemory,
} from '@/lib/agent-memory';

/** Persistent chat memory shares the agent_memory table under a fixed scope. */
class InvalidMemoryScopeError extends Error {}

async function resolveMemoryScope(requested: unknown): Promise<string> {
  const scope = requested === undefined || requested === null || String(requested).trim() === ''
    ? CHAT_MEMORY_SCOPE
    : String(requested).trim();
  if (scope === CHAT_MEMORY_SCOPE) return scope;
  const { loadAgents } = await import('@/lib/persistence');
  if ((await loadAgents()).some((agent) => agent.id === scope)) return scope;
  throw new InvalidMemoryScopeError(`Unknown memory scope "${scope}". Select an existing agent or shared chat memory.`);
}

/** Backs Grok Chat's research/memory slash commands (/fetch /search /remember /recall). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '');
    if (['remember', 'recall', 'forget'].includes(action) && body.sessionId) {
      const { getChatSession } = await import('@/lib/chat-sessions');
      const session = await getChatSession(String(body.sessionId));
      if (session?.ephemeral) {
        return NextResponse.json(
          { ok: false, error: 'Memories are disabled for ephemeral sessions.' },
          { status: 403 },
        );
      }
    }

    if (action === 'fetch') {
      const page = await webFetch(String(body.url || ''));
      return NextResponse.json({ ok: true, page });
    }

    if (action === 'search') {
      const results = await webSearch(String(body.query || ''));
      return NextResponse.json({ ok: true, results });
    }

    if (action === 'remember') {
      const scope = await resolveMemoryScope(body.agentId);
      const entry = saveMemory(scope, String(body.key || ''), String(body.content || ''), {
        source: 'manual', confidence: 1, status: 'active',
      }).entry;
      const { audit } = await import('@/lib/audit-log');
      audit('chat', 'memory saved', entry.key, { memoryId: entry.id, scope });
      return NextResponse.json({ ok: true, entry });
    }

    if (action === 'recall') {
      const scope = await resolveMemoryScope(body.agentId);
      const entries = recallMemories(scope, body.query ? String(body.query) : undefined);
      return NextResponse.json({ ok: true, entries });
    }

    if (action === 'forget') {
      const scope = await resolveMemoryScope(body.agentId);
      const key = String(body.key || '').trim();
      const removed = deleteMemoryByKey(scope, key);
      const { audit } = await import('@/lib/audit-log');
      if (removed) audit('chat', 'memory deleted', key, { scope });
      return NextResponse.json({ ok: true, removed });
    }

    // Post to X through the configured integration (same path as the agents'
    // x_post tool) — used by the /x chat command.
    if (action === 'post_x') {
      const text = String(body.text || '').trim();
      if (!text) return NextResponse.json({ ok: false, error: 'Nothing to post — /x <text>' }, { status: 400 });
      const { loadConfig } = await import('@/lib/persistence');
      await loadConfig(); // hydrates decrypted integration creds
      const { xPostTweet } = await import('@/lib/integrations');
      const result = await xPostTweet(text);
      const { audit } = await import('@/lib/audit-log');
      audit('integration', 'posted to X', text.slice(0, 120), { via: 'chat', url: result.url });
      return NextResponse.json({ ...result, ok: true });
    }

    return NextResponse.json({ ok: false, error: `Unknown chat tool "${action}"` }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'chat tool failed' },
      { status: e instanceof InvalidMemoryScopeError ? 400 : 500 },
    );
  }
}
