import { test, expect } from '@playwright/test';

type CreatedProject = { ok: true; project: { id: string } };
type CreatedSession = { ok: true; session: { id: string } };
type CreatedAgent = { agent: { id: string } };

const pendingGateReleases = new Set<() => void>();

test.afterEach(async ({ request }) => {
  for (const release of pendingGateReleases) release();
  pendingGateReleases.clear();

  // Best-effort cleanup keeps retries and the shared E2E data directory from
  // accumulating sessions/projects/agents that alter later navigation tests.
  const sessions = await request.get('/api/chat-sessions?archived=1')
    .then((response) => response.json())
    .catch(() => ({ sessions: [] })) as { sessions?: Array<{ id: string; title?: string }> };
  await Promise.allSettled((sessions.sessions || [])
    .filter((session) => session.title?.startsWith('Isolation Chat '))
    .map((session) => request.post('/api/chat-sessions', {
      data: { action: 'delete', id: session.id },
    })));

  const projects = await request.get('/api/projects')
    .then((response) => response.json())
    .catch(() => ({ projects: [] })) as { projects?: Array<{ id: string; name?: string }> };
  await Promise.allSettled((projects.projects || [])
    .filter((project) => project.name?.startsWith('Isolation Project '))
    .map((project) => request.post('/api/projects', {
      data: { action: 'delete', id: project.id },
    })));

  const agents = await request.get('/api/agents')
    .then((response) => response.json())
    .catch(() => ({ agents: [] })) as { agents?: Array<{ id: string; name?: string }> };
  await Promise.allSettled((agents.agents || [])
    .filter((agent) => agent.name?.startsWith('Isolation Agent '))
    .map((agent) => request.post('/api/agents', {
      data: { action: 'delete', id: agent.id },
    })));
});

function streamBody(text: string): string {
  return [
    `data: ${JSON.stringify({ type: 'content', delta: text })}`,
    `data: ${JSON.stringify({ type: 'done', model: 'cloud:test' })}`,
    '',
    '',
  ].join('\n');
}

test('finishing chat A while project chat B is active cannot replace or contaminate B', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectAResponse = await request.post('/api/projects', {
    data: { action: 'create', name: `Isolation Project A ${suffix}` },
  });
  const projectBResponse = await request.post('/api/projects', {
    data: { action: 'create', name: `Isolation Project B ${suffix}` },
  });
  expect(projectAResponse.ok()).toBeTruthy();
  expect(projectBResponse.ok()).toBeTruthy();
  const projectA = (await projectAResponse.json() as CreatedProject).project;
  const projectB = (await projectBResponse.json() as CreatedProject).project;
  const agentResponse = await request.post('/api/agents', {
    data: {
      name: `Isolation Agent ${suffix}`,
      model: 'cloud:test',
      description: 'Owns only isolation chat A',
      workspace: { path: process.cwd(), useWorktree: false },
    },
  });
  expect(agentResponse.ok()).toBeTruthy();
  const agent = (await agentResponse.json() as CreatedAgent).agent;

  const sessionAResponse = await request.post('/api/chat-sessions', {
    data: {
      action: 'create',
      defaults: {
        title: `Isolation Chat A ${suffix}`,
        projectId: projectA.id,
        chatTarget: agent.id,
        chatModel: 'cloud:test',
        toolsEnabled: false,
      },
    },
  });
  const sessionBResponse = await request.post('/api/chat-sessions', {
    data: {
      action: 'create',
      defaults: {
        title: `Isolation Chat B ${suffix}`,
        projectId: projectB.id,
        chatModel: 'cloud:test',
        toolsEnabled: false,
      },
    },
  });
  expect(sessionAResponse.ok()).toBeTruthy();
  expect(sessionBResponse.ok()).toBeTruthy();
  const sessionA = (await sessionAResponse.json() as CreatedSession).session;
  const sessionB = (await sessionBResponse.json() as CreatedSession).session;

  let releaseA!: () => void;
  let releaseB!: () => void;
  let markAStarted!: () => void;
  let markBStarted!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  pendingGateReleases.add(releaseA);
  pendingGateReleases.add(releaseB);
  const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
  const bStarted = new Promise<void>((resolve) => { markBStarted = resolve; });

  await page.route('**/api/grok/stream', async (route) => {
    const body = route.request().postDataJSON() as { sessionId?: string };
    if (body.sessionId === sessionA.id) {
      markAStarted();
      await gateA;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache, no-transform' },
        body: streamBody(`A_RESULT_${suffix}`),
      });
      return;
    }
    if (body.sessionId === sessionB.id) {
      markBStarted();
      await gateB;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache, no-transform' },
        body: streamBody(`B_RESULT_${suffix}`),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/chat/${sessionA.id}`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea.grok-chat-textarea');
  const targetPicker = page.locator('select[title*="Chat as Grok"]');
  await expect(composer).toBeVisible();
  await expect(targetPicker).toHaveValue(agent.id);
  await composer.fill(`A_REQUEST_${suffix}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await aStarted;

  await page.getByTestId('chat-session-rail')
    .getByRole('button', { name: new RegExp(`^Isolation Chat B ${suffix}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionB.id}$`));
  await expect(composer).toBeVisible();
  await expect(targetPicker).toHaveValue('grok');
  await composer.fill(`B_REQUEST_${suffix}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await bStarted;

  releaseA();
  await expect.poll(async () => {
    const data = await page.evaluate(async (id) => {
      const response = await fetch(`/api/chat-sessions?id=${encodeURIComponent(id)}`);
      return response.json();
    }, sessionA.id) as { session?: { messages?: Array<{ content?: string }> } };
    return data.session?.messages?.map((message) => message.content).join('\n') || '';
  }).toContain(`A_RESULT_${suffix}`);

  await expect(page).toHaveURL(new RegExp(`/chat/${sessionB.id}$`));
  await expect(page.locator('.grok-chat-messages')).toContainText(`B_REQUEST_${suffix}`);
  await expect(page.locator('.grok-chat-messages')).not.toContainText(`A_RESULT_${suffix}`);

  releaseB();
  await expect(page.locator('.grok-chat-messages')).toContainText(`B_RESULT_${suffix}`);
  await expect(page.locator('.grok-chat-messages')).not.toContainText(`A_RESULT_${suffix}`);

  const persistedB = await expect.poll(async () => {
    const data = await page.evaluate(async (id) => {
      const response = await fetch(`/api/chat-sessions?id=${encodeURIComponent(id)}`);
      return response.json();
    }, sessionB.id) as { session?: { messages?: Array<{ content?: string }> } };
    return data.session?.messages?.map((message) => message.content).join('\n') || '';
  });
  await persistedB.toContain(`B_RESULT_${suffix}`);
  await persistedB.not.toContain(`A_RESULT_${suffix}`);

  await page.getByTestId('chat-session-rail')
    .getByRole('button', { name: new RegExp(`^Isolation Chat A ${suffix}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionA.id}$`));
  await expect(targetPicker).toHaveValue(agent.id);
});

test('voice-group turns stay attached to their durable session across chat switches', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [projectAResponse, projectBResponse] = await Promise.all([
    request.post('/api/projects', {
      data: { action: 'create', name: `Isolation Project Voice A ${suffix}` },
    }),
    request.post('/api/projects', {
      data: { action: 'create', name: `Isolation Project Voice B ${suffix}` },
    }),
  ]);
  expect(projectAResponse.ok()).toBeTruthy();
  expect(projectBResponse.ok()).toBeTruthy();
  const projectA = (await projectAResponse.json() as CreatedProject).project;
  const projectB = (await projectBResponse.json() as CreatedProject).project;

  const agentResponses = await Promise.all(['A', 'B'].map((label) => request.post('/api/agents', {
    data: {
      name: `Isolation Agent Voice ${label} ${suffix}`,
      model: `cloud:voice-${label.toLowerCase()}-test`,
      description: `Voice isolation participant ${label}`,
      workspace: { path: process.cwd(), useWorktree: false },
    },
  })));
  expect(agentResponses.every((response) => response.ok())).toBeTruthy();
  const voiceAgents = await Promise.all(agentResponses.map(async (response) =>
    (await response.json() as CreatedAgent).agent));
  const voiceAgentNames = new Map(voiceAgents.map((agent, index) => [
    agent.id,
    `Isolation Agent Voice ${index === 0 ? 'A' : 'B'} ${suffix}`,
  ]));

  const [sessionAResponse, sessionBResponse] = await Promise.all([
    request.post('/api/chat-sessions', {
      data: {
        action: 'create',
        defaults: {
          title: `Isolation Chat Voice A ${suffix}`,
          projectId: projectA.id,
          chatTarget: 'all',
          chatModel: 'cloud:test',
          toolsEnabled: false,
        },
      },
    }),
    request.post('/api/chat-sessions', {
      data: {
        action: 'create',
        defaults: {
          title: `Isolation Chat Voice B ${suffix}`,
          projectId: projectB.id,
          chatTarget: 'all',
          chatModel: 'cloud:test',
          toolsEnabled: false,
        },
      },
    }),
  ]);
  expect(sessionAResponse.ok()).toBeTruthy();
  expect(sessionBResponse.ok()).toBeTruthy();
  const sessionA = (await sessionAResponse.json() as CreatedSession).session;
  const sessionB = (await sessionBResponse.json() as CreatedSession).session;

  let releaseA!: () => void;
  let releaseB!: () => void;
  let markAStarted!: () => void;
  let markBStarted!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  pendingGateReleases.add(releaseA);
  pendingGateReleases.add(releaseB);
  const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
  const bStarted = new Promise<void>((resolve) => { markBStarted = resolve; });
  const payloads = new Map<string, Record<string, unknown>>();

  await page.route('**/api/grok/voice-group-turn', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const sessionId = String(body.sessionId || '');
    payloads.set(sessionId, body);
    if (sessionId === sessionA.id) {
      markAStarted();
      await gateA;
    } else if (sessionId === sessionB.id) {
      markBStarted();
      await gateB;
    } else {
      await route.continue();
      return;
    }
    const agentId = String(body.agentId || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        content: sessionId === sessionA.id
          ? `A_VOICE_RESULT_${suffix}`
          : `B_VOICE_RESULT_${suffix}`,
        agent: {
          id: agentId,
          name: voiceAgentNames.get(agentId) || 'Voice agent',
          model: 'cloud:voice-test',
        },
      }),
    });
  });

  const composer = page.locator('textarea.grok-chat-textarea');
  const targetPicker = page.locator('select[title*="Chat as Grok"], select[title*="All agents"]');
  await page.goto(`/chat/${sessionA.id}`, { waitUntil: 'domcontentloaded' });
  await expect(composer).toBeVisible();
  await expect(targetPicker).toHaveValue('all');
  await page.getByRole('button', { name: 'Turn on Grok Voice agent' }).click();
  await page.getByRole('button', { name: 'Minimize Grok Voice' }).click();
  await composer.fill(`A_VOICE_REQUEST_${suffix}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await aStarted;

  await page.getByTestId('chat-session-rail')
    .getByRole('button', { name: new RegExp(`^Isolation Chat Voice B ${suffix}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionB.id}$`));
  await expect(targetPicker).toHaveValue('all');
  await page.getByRole('button', { name: 'Turn on Grok Voice agent' }).click();
  await page.getByRole('button', { name: 'Minimize Grok Voice' }).click();
  await composer.fill(`B_VOICE_REQUEST_${suffix}`);
  await expect(composer).toHaveValue(`B_VOICE_REQUEST_${suffix}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await bStarted;
  await page.getByRole('button', { name: 'Turn off Grok Voice agent' }).click();

  for (const payload of payloads.values()) {
    expect(payload.sessionId).toBeTruthy();
    expect(payload.agentId).toBeTruthy();
    expect(payload).not.toHaveProperty('messages');
    expect(payload).not.toHaveProperty('participantIds');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('projectContext');
  }

  releaseA();
  await expect.poll(async () => {
    const response = await request.get(`/api/chat-sessions?id=${encodeURIComponent(sessionA.id)}`);
    const data = await response.json() as { session?: { messages?: Array<{ content?: string }> } };
    return data.session?.messages?.map((message) => message.content).join('\n') || '';
  }).toContain(`A_VOICE_RESULT_${suffix}`);
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionB.id}$`));
  await expect(page.locator('.grok-chat-messages')).not.toContainText(`A_VOICE_RESULT_${suffix}`);

  releaseB();
  await expect(page.locator('.grok-chat-messages')).toContainText(`B_VOICE_RESULT_${suffix}`);
  await expect(page.locator('.grok-chat-messages')).not.toContainText(`A_VOICE_RESULT_${suffix}`);

  await page.getByTestId('chat-session-rail')
    .getByRole('button', { name: new RegExp(`^Isolation Chat Voice A ${suffix}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionA.id}$`));
  await expect(page.locator('.grok-chat-messages')).toContainText(`A_VOICE_RESULT_${suffix}`);
  await expect(page.locator('.grok-chat-messages')).not.toContainText(`B_VOICE_RESULT_${suffix}`);
});

test('a stale durable agent target falls back to a valid Grok picker option', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await request.post('/api/chat-sessions', {
    data: {
      action: 'create',
      defaults: {
        title: `Isolation Chat Stale Target ${suffix}`,
        chatTarget: `deleted-agent-${suffix}`,
        chatModel: 'cloud:test',
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const session = (await response.json() as CreatedSession).session;

  await page.goto(`/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
  const targetPicker = page.locator('select[title*="Chat as Grok"]');
  await expect(targetPicker).toBeVisible();
  await expect(targetPicker).toHaveValue('grok');
});
