import { NextRequest, NextResponse } from 'next/server';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  forkChatSession,
  getChatSession,
  groupChatSessionsByProject,
  listChatSessions,
  markChatSessionRead,
  searchChatSessions,
  updateChatSession,
} from '@/lib/chat-sessions';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const session = await getChatSession(id);
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true, session });
  }
  const q = req.nextUrl.searchParams.get('q');
  const includeArchived = req.nextUrl.searchParams.get('archived') === '1';
  const sessions = q
    ? await searchChatSessions(q, { includeArchived })
    : await listChatSessions({ includeArchived });
  return NextResponse.json({
    ok: true,
    sessions,
    groups: groupChatSessionsByProject(sessions),
    count: sessions.length,
    unreadCount: sessions.reduce((sum, session) => sum + Math.max(0, Number(session.unreadCount) || 0), 0),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === 'create') {
    const session = await createChatSession(body.defaults || {});
    return NextResponse.json({ ok: true, session });
  }

  if (body.action === 'update') {
    const session = await updateChatSession(body.id, body.patch || {});
    return NextResponse.json({ ok: true, session });
  }

  if (body.action === 'fork') {
    const session = await forkChatSession(
      String(body.parentSessionId || ''),
      String(body.sourceMessageId || ''),
      { title: body.title ? String(body.title) : undefined },
    );
    return NextResponse.json({ ok: true, session }, { status: 201 });
  }

  if (body.action === 'markRead') {
    const session = await markChatSessionRead(
      String(body.id || ''),
      body.throughMessageId ? String(body.throughMessageId) : undefined,
    );
    return NextResponse.json({ ok: true, session });
  }

  if (body.action === 'delete') {
    await deleteChatSession(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'archive') {
    const session = await archiveChatSession(body.id, body.archived !== false);
    return NextResponse.json({ ok: true, session });
  }

  // After a chat's first exchange: summarize it into a short title with a
  // low-end model (fast/cheap), so the session list reads at a glance.
  if (body.action === 'autotitle') {
    try {
      const session = await getChatSession(body.id);
      if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const firstUser = (session.messages || []).find((m) => m.role === 'user');
      const firstAssistant = (session.messages || []).find((m) => m.role === 'assistant');
      if (!firstUser || !firstAssistant) {
        return NextResponse.json({ ok: true, session, skipped: 'not enough messages' });
      }

      const { grokChat } = await import('@/lib/grok-client');
      const { loadConfig } = await import('@/lib/persistence');
      const { resolveCloudBearer } = await import('@/lib/xai-oauth');
      const { parseModelRef } = await import('@/lib/model-providers');
      const cfg = await loadConfig();

      const prompt = [
        'Summarize this conversation as a title of 3 to 6 words. Reply with ONLY the title — no quotes, no punctuation at the end.',
        `User: ${String(firstUser.content || '').slice(0, 600)}`,
        `Assistant: ${String(firstAssistant.content || '').slice(0, 600)}`,
      ].join('\n\n');

      const titleWithModel = async (rawModel: string) => {
        const ref = parseModelRef(rawModel);
        const auth = ref.provider === 'cloud'
          ? await resolveCloudBearer(cfg, ref.authSource)
          : { token: null };
        return grokChat({
          model: ref.encoded,
          cloudKey: auth.token || undefined,
          signal: req.signal,
          messages: [{ role: 'user' as const, content: prompt }],
          max_tokens: 24,
          temperature: 0.2,
        });
      };

      const cheapModel = 'grok-code-fast-1';
      let title = '';
      try {
        const res = await titleWithModel(cheapModel);
        title = res.choices?.[0]?.message?.content?.trim() || '';
      } catch {
        // Cheap model unavailable — fall back to the configured default.
        const res = await titleWithModel(cfg.defaultGrokModel || 'grok-4.3-latest');
        title = res.choices?.[0]?.message?.content?.trim() || '';
      }
      title = title.replace(/^["'`]+|["'`.]+$/g, '').slice(0, 60);
      if (!title) return NextResponse.json({ ok: true, session, skipped: 'empty title' });

      const updated = await updateChatSession(body.id, { title });
      const { audit } = await import('@/lib/audit-log');
      audit('chat', 'session auto-titled', title, { sessionId: body.id, model: cheapModel });
      return NextResponse.json({ ok: true, session: updated });
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'autotitle failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
