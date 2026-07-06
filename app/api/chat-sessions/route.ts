import { NextRequest, NextResponse } from 'next/server';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
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
  return NextResponse.json({ ok: true, sessions, count: sessions.length });
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

  if (body.action === 'delete') {
    await deleteChatSession(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'archive') {
    const session = await archiveChatSession(body.id, body.archived !== false);
    return NextResponse.json({ ok: true, session });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}