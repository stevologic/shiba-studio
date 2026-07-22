import './verify-isolate';
import assert from 'node:assert/strict';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  process.env.SHIBA_SECRET_KEY ||= '55'.repeat(32);

  const dbModule = await import('../lib/db');
  const context = await import('../lib/context-engine');
  const { executeAgentTool } = await import('../lib/agent-tool-exec');
  const { normalizeAgent } = await import('../lib/types');
  const ledger = await import('../lib/task-ledger');
  const background = await import('../lib/background-tasks');
  const persistence = await import('../lib/persistence');
  const projects = await import('../lib/projects');
  const chatSessions = await import('../lib/chat-sessions');
  const voiceGroupScope = await import('../lib/voice-group-session');
  const now = new Date().toISOString();
  const agent = normalizeAgent({
    id: 'chat-isolation-agent',
    name: 'Chat Isolation Agent',
    model: 'local:test',
    description: 'Deterministic chat isolation verifier',
    workspace: { path: process.cwd(), useWorktree: false },
    integrations: {},
    peers: [],
    skills: [],
    createdAt: now,
    updatedAt: now,
  });

  try {
    const voiceAgentA = normalizeAgent({
      ...agent,
      id: 'voice-agent-a',
      name: 'Voice Agent A',
      model: 'cloud:voice-agent-a-model',
    });
    const voiceAgentB = normalizeAgent({
      ...agent,
      id: 'voice-agent-b',
      name: 'Voice Agent B',
      model: 'cloud:voice-agent-b-model',
    });
    await persistence.saveAgents([voiceAgentA, voiceAgentB]);
    const voiceProject = await projects.createProject(
      'Voice Isolation Project',
      'voice-project-private-marker',
    );
    const voiceSession = await chatSessions.createChatSession({
      title: 'Voice isolation session',
      chatTarget: 'all',
      chatModel: 'cloud:session-owned-model',
      projectId: voiceProject.id,
    });
    await chatSessions.updateChatSession(voiceSession.id, {
      messages: [
        {
          id: 'voice-user',
          role: 'user',
          content: 'voice-session-private-marker',
          createdAt: now,
        },
        {
          id: 'voice-placeholder',
          role: 'assistant',
          content: '',
          streaming: true,
          createdAt: now,
        },
      ],
    });
    const voiceScope = await voiceGroupScope.resolveVoiceGroupSessionScope({
      sessionId: voiceSession.id,
      agentId: voiceAgentA.id,
    });
    if (!voiceScope.ok) throw new Error(voiceScope.error);
    assert.equal(voiceScope.ok, true);
    assert.equal(voiceScope.chatModel, 'cloud:session-owned-model');
    assert.equal(voiceScope.agent.id, voiceAgentA.id);
    assert.deepEqual(voiceScope.peers, [{ id: voiceAgentB.id, name: voiceAgentB.name }]);
    assert.deepEqual(voiceScope.history.map((message) => message.content), ['voice-session-private-marker']);
    assert.match(voiceScope.projectContext, /voice-project-private-marker/);

    const wrongModeSession = await chatSessions.createChatSession({ chatTarget: 'grok' });
    const wrongMode = await voiceGroupScope.resolveVoiceGroupSessionScope({
      sessionId: wrongModeSession.id,
      agentId: voiceAgentA.id,
    });
    assert.deepEqual(wrongMode, {
      ok: false,
      status: 409,
      error: 'Chat session is not in voice-group mode',
    });
    const missingParticipant = await voiceGroupScope.resolveVoiceGroupSessionScope({
      sessionId: voiceSession.id,
      agentId: 'deleted-voice-agent',
    });
    assert.equal(missingParticipant.ok, false);
    if (!missingParticipant.ok) assert.equal(missingParticipant.status, 409);

    const staleTargetSession = await chatSessions.createChatSession({
      chatTarget: 'deleted-chat-agent',
      chatModel: 'cloud:test',
    });
    await chatSessions.updateChatSession(staleTargetSession.id, {
      messages: [{ id: 'stale-user', role: 'user', content: 'do not run', createdAt: now }],
    });
    const { NextRequest } = await import('next/server');
    const staleBody = JSON.stringify({ sessionId: staleTargetSession.id, messages: [] });
    const grokRoute = await import('../app/api/grok/stream/route');
    const staleGrokResponse = await grokRoute.POST(new NextRequest('http://localhost/api/grok/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: staleBody,
    }));
    assert.equal(staleGrokResponse.status, 409);
    const cliRoute = await import('../app/api/grok-cli/stream/route');
    const staleCliResponse = await cliRoute.POST(new NextRequest('http://localhost/api/grok-cli/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: staleBody,
    }));
    assert.equal(staleCliResponse.status, 409);

    assert.deepEqual(
      context.modelReadyChatHistory([
        { id: 'user-current', role: 'user', content: 'current turn' },
        { id: 'assistant-placeholder', role: 'assistant', content: '', streaming: true },
      ]).map((message) => message.id),
      ['user-current'],
      'a persisted live-run placeholder must never become model history',
    );
    const trustedRequestHistory = context.modelRequestChatHistory(
      [
        { id: 'session-b-user', role: 'user', content: 'trusted beta request' },
        { id: 'session-b-placeholder', role: 'assistant', content: '', streaming: true },
      ],
      [{ id: 'forged-session-a-user', role: 'user', content: 'private alpha transcript' }],
    );
    assert.deepEqual(
      trustedRequestHistory.map((message) => message.id),
      ['session-b-user'],
      'durable session history must replace a crafted client transcript and drop the live placeholder',
    );

    context.indexSessionMessages('session-a', [{
      id: 'a-message',
      role: 'user',
      content: 'private-alpha-marker belongs only to project alpha',
      createdAt: now,
    }], 'project-a');
    context.indexSessionMessages('session-b', [{
      id: 'b-message',
      role: 'user',
      content: 'private-beta-marker belongs only to project beta',
      createdAt: now,
    }], 'project-b');

    const sessionBAuth = {
      contextScope: { kind: 'session' as const, sessionId: 'session-b', projectId: 'project-b' },
    };
    const forgedSearch = await executeAgentTool(
      'session_search',
      {
        query: 'private-alpha-marker',
        session_id: 'session-a',
        project_id: 'project-a',
      },
      agent,
      {},
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionBAuth,
    );
    assert.deepEqual(
      forgedSearch.result.matches,
      [],
      'model-selected ids must not move search outside the server-owned session',
    );

    const ownSearch = await executeAgentTool(
      'session_search',
      { query: 'private-beta-marker' },
      agent,
      {},
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionBAuth,
    );
    assert.equal(ownSearch.result.matches.length, 1);
    assert.equal(ownSearch.result.matches[0].citation.scopeId, 'session-b');

    const crossSource = await executeAgentTool(
      'session_search',
      { source_id: 'ctx:session:session-a:message:a-message' },
      agent,
      {},
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionBAuth,
    );
    assert.match(crossSource.result.error || '', /not available in this execution scope/);
    assert.equal(
      JSON.stringify(crossSource.result).includes('private-alpha-marker'),
      false,
      'an out-of-scope exact citation must not disclose source content',
    );

    // Durable task ownership is another trusted scope source. Even without an
    // explicit authorization object, a chat worker may search only its chat.
    ledger.createTask({
      id: 'session-b-owned-task',
      kind: 'work',
      title: 'Session B owned task',
      originType: 'chat',
      originId: 'session-b',
      sessionId: 'session-b',
      projectId: 'project-b',
      status: 'running',
    });
    const taskScopedSearch = await executeAgentTool(
      'session_search',
      { query: 'private-alpha-marker', session_id: 'session-a' },
      agent,
      { taskId: 'session-b-owned-task', projectId: 'project-a' },
      process.cwd(),
    );
    assert.deepEqual(taskScopedSearch.result.matches, []);

    // The public background-dispatch path must persist both ownership ids and
    // the exact project context before its detached worker starts.
    const started = background.startBackgroundTask({
      prompt: 'Return a deterministic test result.',
      sessionId: 'session-b',
      projectId: 'project-b',
      projectContext: 'Project Beta trusted context',
      workspaceDir: process.cwd(),
      model: 'local:test',
    });
    const stored = ledger.getTask(started.taskId);
    assert.equal(started.sessionId, 'session-b');
    assert.equal(started.projectId, 'project-b');
    assert.equal(stored?.sessionId, 'session-b');
    assert.equal(stored?.projectId, 'project-b');
    assert.equal(stored?.metadata.projectContext, 'Project Beta trusted context');
    assert.deepEqual(background.backgroundTaskTestHooks.runScopeForTask(stored!), {
      projectId: 'project-b',
      projectContext: 'Project Beta trusted context',
      workspacePathOverride: process.cwd(),
    });

    // Local test models fail before model execution when disabled; wait for the
    // detached promise to settle so teardown never races an open database.
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = ledger.getTask(started.taskId)?.status;
      if (status && ['succeeded', 'failed', 'cancelled', 'lost'].includes(status)) break;
      await wait(25);
    }
    assert(
      ['succeeded', 'failed', 'cancelled', 'lost'].includes(ledger.getTask(started.taskId)?.status || ''),
      'detached background verifier should settle before teardown',
    );

    console.log('CHAT_ISOLATION_OK search=session-owned source=guarded task=durably-scoped background=project-owned voice=session-owned stale-target=409');
  } finally {
    await background.stopQueuedRetryDispatcher();
    const delivery = await import('../lib/task-delivery');
    await delivery.stopTaskDeliveryPump();
    dbModule.closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
