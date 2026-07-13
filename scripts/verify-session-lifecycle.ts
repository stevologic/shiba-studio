import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-session-lifecycle-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '66'.repeat(32);

  const dbModule = await import('../lib/db');
  const chats = await import('../lib/chat-sessions');
  const context = await import('../lib/context-engine');
  const liveChats = await import('../lib/chat-live-runs');
  const chatToolsApi = await import('../app/api/chat-tools/route');
  const chatSessionsApi = await import('../app/api/chat-sessions/route');

  try {
    const now = new Date().toISOString();
    const parent = await chats.createChatSession({
      title: 'Parent session',
      projectId: 'project-group-a',
      chatModel: 'cloud:test',
    });
    const userMessage = { id: 'user-1', role: 'user' as const, content: 'Keep the parent immutable.', createdAt: now };
    const streamingAssistant = {
      id: 'assistant-1', role: 'assistant' as const, content: 'Working…', streaming: true, createdAt: now,
    };
    const duringStream = await chats.updateChatSession(parent.id, { messages: [userMessage, streamingAssistant] });
    assert.equal(duringStream.unreadCount, 0, 'streaming placeholders are not unread completions');
    const completedAssistant = { ...streamingAssistant, content: 'Complete.', streaming: false };
    const completed = await chats.updateChatSession(parent.id, { messages: [userMessage, completedAssistant] });
    assert.equal(completed.unreadCount, 1, 'assistant completion transition increments unread exactly once');
    const repeated = await chats.updateChatSession(parent.id, { messages: [userMessage, completedAssistant] });
    assert.equal(repeated.unreadCount, 1, 're-saving a completed message is idempotent');
    const read = await chats.markChatSessionRead(parent.id, completedAssistant.id);
    assert.equal(read.unreadCount, 0);
    assert.equal(read.lastReadMessageId, completedAssistant.id);
    await chats.appendChatMessage(parent.id, {
      id: 'assistant-2', role: 'assistant', content: 'Detached completion.', createdAt: now,
    });
    assert.equal((await chats.getChatSession(parent.id))?.unreadCount, 1, 'outbox append increments unread');

    const originalFetch = globalThis.fetch;
    const persistRequests: Array<{ body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      persistRequests.push({
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        resolve,
      });
    })) as typeof fetch;
    try {
      liveChats.beginLiveChatRun('persist-order', [{ id: 'live-user', role: 'user', content: 'hello' }]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(persistRequests.length, 1, 'the initial running snapshot should begin immediately');
      liveChats.abortLiveChatRun('persist-order');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(persistRequests.length, 1, 'the terminal snapshot must wait behind an older in-flight write');
      persistRequests[0].resolve(new Response('{}', { status: 200 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(persistRequests.length, 2, 'the terminal snapshot should follow the older write');
      assert.equal(
        (persistRequests[1].body.patch as { running?: boolean }).running,
        false,
        'a stale running snapshot cannot overtake the terminal chat state',
      );
      persistRequests[1].resolve(new Response('{}', { status: 200 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = originalFetch;
    }

    const parentBeforeFork = JSON.stringify(await chats.getChatSession(parent.id));
    const child = await chats.forkChatSession(parent.id, completedAssistant.id);
    const parentAfterFork = JSON.stringify(await chats.getChatSession(parent.id));
    assert.equal(parentAfterFork, parentBeforeFork, 'forking must not mutate any parent field or message');
    assert.deepEqual(child.messages.map((message) => message.id), ['user-1', 'assistant-1']);
    assert.equal(child.branch?.parentSessionId, parent.id);
    assert.equal(child.branch?.rootSessionId, parent.id);
    assert.equal(child.branch?.sourceMessageId, completedAssistant.id);
    assert.equal(child.branch?.sourceMessageOrdinal, 1);
    assert.equal(child.branch?.kind, 'checkpoint-branch-v1');
    assert.equal(child.projectId, 'project-group-a');
    assert.equal(child.unreadCount, 0);

    const tampered = await chats.updateChatSession(child.id, {
      title: 'Child renamed',
      ephemeral: true,
      unreadCount: 99,
      branch: {
        kind: 'checkpoint-branch-v1',
        parentSessionId: 'forged',
        rootSessionId: 'forged',
        sourceMessageId: 'forged',
        sourceMessageOrdinal: 99,
        depth: 99,
        createdAt: now,
      },
    });
    assert.equal(tampered.title, 'Child renamed');
    assert.equal(tampered.ephemeral, false, 'ordinary updates cannot broaden lifecycle semantics');
    assert.equal(tampered.unreadCount, 0, 'ordinary updates cannot forge read state');
    assert.equal(tampered.branch?.parentSessionId, parent.id, 'branch ancestry is immutable');

    const grandchild = await chats.forkChatSession(child.id, userMessage.id);
    assert.equal(grandchild.branch?.parentSessionId, child.id);
    assert.equal(grandchild.branch?.rootSessionId, parent.id);
    assert.equal(grandchild.branch?.depth, 2);

    const childBranchBeforeRewind = structuredClone(child.branch);
    const rewoundChild = await chats.rewindChatSessionToMessage({
      sessionId: child.id,
      sourceMessageId: userMessage.id,
      confirmSourceMessageId: userMessage.id,
      expectedCurrentLastMessageId: completedAssistant.id,
    });
    assert.deepEqual(rewoundChild.messages.map((message) => message.id), [userMessage.id]);
    assert.deepEqual(rewoundChild.branch, childBranchBeforeRewind, 'destructive rewind cannot rewrite branch ancestry');
    assert.equal(context.inspectContextScope('session', child.id).sources.length, 1, 'rewind regenerates active context sources');
    await assert.rejects(
      () => chats.rewindChatSessionToMessage({
        sessionId: child.id,
        sourceMessageId: userMessage.id,
        confirmSourceMessageId: 'wrong-cursor',
      }),
      /must exactly match/,
    );
    await assert.rejects(
      () => chats.rewindChatSessionToMessage({
        sessionId: child.id,
        sourceMessageId: userMessage.id,
        confirmSourceMessageId: userMessage.id,
        expectedCurrentLastMessageId: completedAssistant.id,
      }),
      /changed after rewind preflight/,
    );

    const projectGroup = chats.groupChatSessionsByProject(await chats.listChatSessions())
      .find((group) => group.projectId === 'project-group-a');
    assert(projectGroup);
    assert.equal(projectGroup.sessions.length, 3);
    assert.equal(projectGroup.unreadCount, 1);

    const apiForkResponse = await chatSessionsApi.POST(new NextRequest('http://localhost/api/chat-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fork',
        parentSessionId: parent.id,
        sourceMessageId: userMessage.id,
        title: 'API fork',
      }),
    }));
    assert.equal(apiForkResponse.status, 201);
    const apiFork = await apiForkResponse.json();
    assert.equal(apiFork.session.messages.length, 1);
    const listResponse = await chatSessionsApi.GET(new NextRequest('http://localhost/api/chat-sessions'));
    const listPayload = await listResponse.json();
    assert(listPayload.groups.some((group: { projectId: string }) => group.projectId === 'project-group-a'));
    assert.equal(listPayload.unreadCount, 1);

    const ephemeral = await chats.createChatSession({ title: 'Incognito', ephemeral: true });
    assert.equal(ephemeral.ephemeral, true);
    await assert.rejects(() => chats.archiveChatSession(ephemeral.id, true), /cannot be archived/);
    const blockedMemoryResponse = await chatToolsApi.POST(new NextRequest('http://localhost/api/chat-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remember',
        sessionId: ephemeral.id,
        key: 'must-not-persist',
        content: 'secret',
      }),
    }));
    assert.equal(blockedMemoryResponse.status, 403, 'ephemeral memory writes are rejected at the server boundary');
    assert.equal(
      Number((dbModule.getDb().prepare("SELECT COUNT(*) AS count FROM agent_memory WHERE key = 'must-not-persist'").get() as { count: number }).count),
      0,
    );

    const ephemeralWithMessages = await chats.updateChatSession(ephemeral.id, { messages: [userMessage] });
    assert.equal(ephemeralWithMessages.ephemeral, true);
    const ephemeralFork = await chats.forkChatSession(ephemeral.id, userMessage.id);
    assert.equal(ephemeralFork.ephemeral, true, 'privacy lifecycle is inherited by forks');
    await chats.updateChatSession(ephemeral.id, { ephemeral: false });
    assert.equal((await chats.getChatSession(ephemeral.id))?.ephemeral, true, 'ordinary updates cannot make an ephemeral chat durable');
    assert.equal(context.inspectContextScope('session', ephemeral.id).sources.length, 1);
    await chats.deleteChatSession(ephemeral.id);
    assert.equal(await chats.getChatSession(ephemeral.id), null);
    assert.equal(context.inspectContextScope('session', ephemeral.id).sources.length, 0, 'ephemeral deletion removes its context index');

    const streamSource = await fs.readFile(path.join(process.cwd(), 'app/api/grok/stream/route.ts'), 'utf8');
    assert(streamSource.includes('if (!ephemeralSession)'), 'ephemeral chat must skip automatic memory recall');
    assert(streamSource.includes("'background_task'"), 'ephemeral tool filter must remove learning background dispatch');
    assert(streamSource.includes('privateTools'), 'ephemeral tool filter should be enforced server-side');
    const sessionsPanelSource = await fs.readFile(path.join(process.cwd(), 'components/chat-sessions-panel.tsx'), 'utf8');
    assert(sessionsPanelSource.includes('groupChatSessionsByProject'));
    assert(sessionsPanelSource.includes('registerBrowserEphemeralSession(created.id)'), 'only sessions created by this browser lifecycle are registered for close cleanup');
    const ephemeralLifecycleSource = await fs.readFile(path.join(process.cwd(), 'lib/ephemeral-chat-lifecycle.ts'), 'utf8');
    assert(ephemeralLifecycleSource.includes("window.addEventListener('pagehide'"), 'ephemeral cleanup follows the browser lifecycle rather than a SPA component unmount');
    assert(ephemeralLifecycleSource.includes("navigator.sendBeacon('/api/chat-sessions'"));
    assert(ephemeralLifecycleSource.includes('browserLifecycleSessionIds'), 'cleanup cannot claim sessions created by another browser or device');
    assert(sessionsPanelSource.includes('<ContextInspector'));
    const chatPanelSource = await fs.readFile(path.join(process.cwd(), 'components/grok-chat-panel.tsx'), 'utf8');
    assert(chatPanelSource.includes('forkFromMessage'));
    assert(chatPanelSource.includes("action: 'fork'"));

    console.log('SESSION_LIFECYCLE_OK fork=immutable grouping=project unread=idempotent ephemeral=no-memory+delete-on-close-contract');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
