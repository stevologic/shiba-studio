import { NextRequest, NextResponse } from 'next/server';
import { memoryRecall, memorySave, webFetch, webSearch } from '@/lib/agent-power-tools';

/** Persistent chat memory shares the agent_memory table under a fixed scope. */
const CHAT_MEMORY_SCOPE = '__chat__';

/** Backs Grok Chat's research/memory slash commands (/fetch /search /remember /recall). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'fetch') {
      const page = await webFetch(String(body.url || ''));
      return NextResponse.json({ ok: true, page });
    }

    if (action === 'search') {
      const results = await webSearch(String(body.query || ''));
      return NextResponse.json({ ok: true, results });
    }

    if (action === 'remember') {
      const entry = memorySave(CHAT_MEMORY_SCOPE, String(body.key || ''), String(body.content || ''));
      const { audit } = await import('@/lib/audit-log');
      audit('chat', 'memory saved', entry.key);
      return NextResponse.json({ ok: true, entry });
    }

    if (action === 'recall') {
      const entries = memoryRecall(CHAT_MEMORY_SCOPE, body.query ? String(body.query) : undefined);
      return NextResponse.json({ ok: true, entries });
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
      return NextResponse.json({ ok: true, ...result });
    }

    return NextResponse.json({ ok: false, error: `Unknown chat tool "${action}"` }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'chat tool failed' }, { status: 500 });
  }
}
