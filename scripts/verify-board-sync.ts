/**
 * Focused verification for the Linear + Jira Board integrations.
 *
 * Provider traffic is intercepted at global fetch, and persistence is rooted
 * in a fresh SHIBA_DATA_DIR so this script cannot touch a live studio board.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(SCRATCH, 'verify-board-sync.log');
const lines: string[] = [];
let passed = 0;

function log(message: string) {
  lines.push(message);
  console.log(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  log(`OK ${name}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  provider: 'linear' | 'jira';
  url: string;
  method: string;
  body?: Record<string, unknown>;
  authorization?: string | null;
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  log(`BOARD_SYNC_VERIFY ${new Date().toISOString()}`);

  // Set these before importing any persistence or Board module. secure-store
  // uses the fixed test key and therefore never creates a key in the real home.
  const parentDataDir = process.env.SHIBA_DATA_DIR || SCRATCH;
  const testDataDir = path.join(parentDataDir, `verify-board-sync-${process.pid}-${Date.now()}`);
  process.env.SHIBA_DATA_DIR = testDataDir;
  process.env.SHIBA_SECRET_KEY = '7a'.repeat(32);
  await fs.mkdir(testDataDir, { recursive: true });
  log(`DATA_DIR=${testDataDir}`);

  await check('catalog and icons', async () => {
    const catalog = await import('../lib/integration-catalog');
    for (const provider of ['linear', 'jira'] as const) {
      assert(catalog.INTEGRATION_IDS.includes(provider), `catalog includes ${provider}`);
      const meta = catalog.getIntegrationMeta(provider);
      assert(meta?.label === (provider === 'linear' ? 'Linear' : 'Jira'), `${provider} label`);
      assert(meta?.icon === `/integrations/${provider}.svg`, `${provider} icon path`);
      assert(/^https:\/\//.test(meta?.docsUrl || ''), `${provider} official docs URL`);
      const svg = await read(`public/integrations/${provider}.svg`);
      assert(svg.includes('<svg'), `${provider}.svg exists`);
    }
  });

  await check('types and Board link state', async () => {
    const types = await read('lib/types.ts');
    const boardTypes = await read('lib/board-types.ts');
    const syncTypes = await import('../lib/board-sync-types');
    assert(types.includes('linear?: {') && types.includes('apiKey: string'), 'Linear credentials typed');
    assert(types.includes('jira?: {') && types.includes('apiToken: string'), 'Jira credentials typed');
    assert(types.includes("syncDirection?: 'pull' | 'push' | 'bidirectional'"), 'sync directions typed');
    assert(boardTypes.includes("BoardExternalProvider = 'linear' | 'jira'"), 'external providers typed');
    assert(boardTypes.includes('externalRefs?: BoardExternalRef[]'), 'tasks persist remote links');
    assert(boardTypes.includes('connectionId?: string'), 'remote links are namespaced to a provider connection');
    assert(boardTypes.includes('fingerprintMode?') && boardTypes.includes('lastLocalFieldFingerprints?'), 'remote links persist mode-aware field baselines');
    assert(boardTypes.includes('syncState?: Partial<Record<BoardExternalProvider, BoardSyncState>>'), 'store persists sync state');
    assert(syncTypes.BOARD_SYNC_PROVIDERS.join(',') === 'linear,jira', 'provider constants');
    assert(syncTypes.BOARD_SYNC_DIRECTIONS.join(',') === 'pull,push,bidirectional', 'direction constants');
    assert(syncTypes.BOARD_SYNC_MODES.join(',') === 'tasks,board', 'mode constants');
  });

  await check('UI and API structural wiring', async () => {
    const studio = await read('components/shiba-studio.tsx');
    const board = await read('components/kanban-board.tsx');
    const modal = await read('components/board-sync-modal.tsx');
    const integrationsApi = await read('app/api/integrations/route.ts');
    const syncApi = await read('app/api/board/sync/route.ts');
    assert(studio.includes("integration.id === 'linear'"), 'Capabilities renders Linear');
    assert(studio.includes("integration.id === 'jira'"), 'Capabilities renders Jira');
    assert(studio.includes('intCreds.linear') && studio.includes('intCreds.jira'), 'credential forms wired');
    assert(board.includes('BoardSyncModal') && board.includes('externalRefs'), 'Board opens sync UI and renders links');
    assert(modal.includes("fetch('/api/board/sync'"), 'sync modal calls Board sync API');
    assert(modal.includes("setDirection('pull')") && modal.includes("setDirection('push')") && modal.includes("setDirection('bidirectional')"), 'all sync directions exposed');
    assert(integrationsApi.includes("which === 'linear'") && integrationsApi.includes('testLinear'), 'Linear connection API branch');
    assert(integrationsApi.includes("which === 'jira'") && integrationsApi.includes('testJira'), 'Jira connection API branch');
    assert(syncApi.includes("action: z.literal('discover')") && syncApi.includes("action: z.literal('sync')"), 'Board API validates discover and sync');
    assert(syncApi.includes('resolveBoardSyncTarget') && syncApi.includes('syncBoard'), 'Board API reaches sync engine');
    assert(syncApi.includes('updateIntegrationConfig'), 'Board API persists provider metadata atomically');
  });

  await check('provider contract structure', async () => {
    const linear = await read('lib/linear.ts');
    const jira = await read('lib/jira.ts');
    const contextStart = linear.indexOf('query ShibaLinearTeamContext');
    const nextOperation = contextStart >= 0
      ? linear.indexOf('query ShibaLinearIssues', contextStart)
      : -1;
    const contextQuery = contextStart >= 0
      ? linear.slice(contextStart, nextOperation >= 0 ? nextOperation : contextStart + 1_800)
      : '';
    assert(contextStart >= 0, 'Linear team context query exists');
    assert(
      !(contextQuery.includes('$teamId: String!') && /id:\s*\{\s*eq:\s*\$teamId\s*\}/.test(contextQuery)),
      'Linear String! team resolver variable is not reused as an IDComparator variable',
    );
    assert(linear.includes('query ShibaLinearIssues($teamId: ID!'), 'Linear issue filter uses ID variable');
    assert(linear.includes('pageInfo { hasNextPage endCursor }'), 'Linear cursor pagination');
    assert(jira.includes('/rest/software/1.0/board/'), 'Jira enhanced Board endpoint');
    assert(jira.includes("params.set('nextPageToken'"), 'Jira enhanced cursor pagination');
    assert(jira.includes('/rest/agile/1.0/board/'), 'Jira legacy Board fallback');
    assert(jira.includes('/rest/api/3/search/jql'), 'Jira enhanced JQL endpoint');
    assert(jira.includes("'/rest/api/3/serverInfo'"), 'Jira validates Cloud ID against the configured site');
  });

  const linearSecret = 'lin_api_verify_board_sync_secret';
  const jiraSecret = 'jira_verify_board_sync_secret';
  const creds = {
    linear: {
      apiKey: linearSecret,
      teamId: 'team-verify-1',
      teamName: 'Verify Linear',
      syncDirection: 'pull' as const,
      syncMode: 'board' as const,
    },
    jira: {
      baseUrl: 'https://verify-shiba.atlassian.net',
      email: 'verify@example.com',
      apiToken: jiraSecret,
      projectKey: 'VRFY',
      projectName: 'Verify Jira',
      issueType: 'Task',
      syncDirection: 'push' as const,
      syncMode: 'board' as const,
    },
  } satisfies import('../lib/types').IntegrationCreds;

  await check('secrets sealed at rest', async () => {
    const persistenceSource = await read('lib/persistence.ts');
    assert(persistenceSource.includes("'integrations.linear.apiKey'"), 'Linear secret registered');
    assert(persistenceSource.includes("'integrations.jira.apiToken'"), 'Jira secret registered');
    const persistence = await import('../lib/persistence');
    persistence.setPersistenceDataDir(testDataDir);
    await persistence.saveConfig({ integrations: creds });
    const raw = await fs.readFile(path.join(testDataDir, 'config.json'), 'utf8');
    assert(!raw.includes(linearSecret), 'Linear API key is not plaintext');
    assert(!raw.includes(jiraSecret), 'Jira API token is not plaintext');
    assert((raw.match(/enc:v1:/g) || []).length >= 2, 'both provider secrets encrypted');
    const loaded = await persistence.loadConfig();
    assert(loaded.integrations.linear?.apiKey === linearSecret, 'Linear key opens in memory');
    assert(loaded.integrations.jira?.apiToken === jiraSecret, 'Jira token opens in memory');
    await Promise.all([
      persistence.saveConfig({ integrations: { linear: { ...creds.linear, teamName: 'Concurrent Linear' } } }),
      persistence.saveConfig({ integrations: { jira: { ...creds.jira, projectName: 'Concurrent Jira' } } }),
    ]);
    const concurrent = await persistence.loadConfig();
    assert(concurrent.integrations.linear?.teamName === 'Concurrent Linear', 'atomic config saves preserve Linear changes');
    assert(concurrent.integrations.jira?.projectName === 'Concurrent Jira', 'atomic config saves preserve Jira changes');
    await persistence.saveConfig({ integrations: creds });
  });

  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  let linearConcurrentEdit = false;
  let linearRemoteTitle = 'Pulled from Linear';
  let failJiraTransitions = false;
  let jiraSearchCreatedIssue = false;
  let linearClock = 0;
  let linearIssue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    priority: number;
    url: string;
    createdAt: string;
    updatedAt: string;
    state: { id: string; name: string; type: string };
    labels: { nodes: Array<{ id: string; name: string }> };
  } | null = null;
  let jiraClock = 0;
  let jiraIssue: {
    id: string;
    key: string;
    fields: Record<string, unknown>;
  } | null = null;

  const nextLinearTimestamp = () => new Date(Date.UTC(2026, 6, 10, 11, 0, linearClock++)).toISOString();
  const nextJiraTimestamp = () => new Date(Date.UTC(2026, 6, 10, 12, 0, jiraClock++)).toISOString();
  const linearStates = new Map([
    ['state-backlog', { id: 'state-backlog', name: 'Backlog', type: 'backlog' }],
    ['state-todo', { id: 'state-todo', name: 'Todo', type: 'unstarted' }],
    ['state-progress', { id: 'state-progress', name: 'In Progress', type: 'started' }],
    ['state-review', { id: 'state-review', name: 'In Review', type: 'started' }],
    ['state-done', { id: 'state-done', name: 'Done', type: 'completed' }],
  ]);
  const todoStatus = { id: '10000', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } };
  const reviewStatus = { id: '10002', name: 'In Review', statusCategory: { key: 'indeterminate', name: 'In Progress' } };
  const doneStatus = { id: '10003', name: 'Done', statusCategory: { key: 'done', name: 'Done' } };
  const jiraPulledIssue = {
    id: '10084',
    key: 'VRFY-84',
    fields: {
      summary: 'Pulled from Jira',
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A stable Jira card' }] }],
      },
      labels: ['sync-test'],
      priority: { id: '2', name: 'High' },
      status: reviewStatus,
      created: '2026-07-10T09:00:00.000Z',
      updated: '2026-07-10T10:00:00.000Z',
      project: { id: '10010', key: 'VRFY', name: 'Verify Jira' },
      issuetype: { id: '10001', name: 'Task' },
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;

    if (url === 'https://api.linear.app/graphql') {
      calls.push({ provider: 'linear', url, method, body, authorization: headers.get('authorization') });
      const query = String(body?.query || '');
      const variables = (body?.variables || {}) as Record<string, unknown>;
      assert(method === 'POST', 'Linear uses POST');

      if (query.includes('ShibaLinearConnection')) {
        return jsonResponse({
          data: {
            viewer: {
              id: 'user-linear-1',
              name: 'Linear Verify User',
              email: 'linear@example.com',
              organization: { id: 'org-1', name: 'Verify Org', urlKey: 'verify-org' },
            },
            organization: { id: 'org-1', name: 'Verify Org', urlKey: 'verify-org' },
            teams: { nodes: [{ id: 'team-verify-1', key: 'LIN', name: 'Verify Linear' }] },
          },
        });
      }

      if (query.includes('ShibaLinearTeamContext')) {
        assert(variables.teamId === 'team-verify-1', 'Linear context receives team ID');
        const states = {
          nodes: [
            { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
            { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
            { id: 'state-progress', name: 'In Progress', type: 'started', position: 2 },
            { id: 'state-review', name: 'In Review', type: 'started', position: 3 },
            { id: 'state-done', name: 'Done', type: 'completed', position: 4 },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
        const labels = {
          nodes: [{ id: 'label-sync', name: 'sync-test', color: '#5E6AD2' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
        // Include both shapes so this mock follows either the root-filtered
        // operation or the preferred Team.states / Team.labels operation.
        return jsonResponse({
          data: {
            team: { id: 'team-verify-1', key: 'LIN', name: 'Verify Linear', states, labels },
            workflowStates: states,
            issueLabels: labels,
          },
        });
      }

      if (query.includes('ShibaLinearIssues')) {
        assert(variables.teamId === 'team-verify-1', 'Linear issue filter receives team ID');
        if (linearConcurrentEdit) {
          linearConcurrentEdit = false;
          const board = await import('../lib/board');
          const [task] = await board.listBoardTasks();
          assert(task, 'linked Linear task exists for concurrent-edit test');
          await board.updateBoardTask(task.id, { title: 'Local edit during sync', actor: 'concurrency verifier' });
        }
        return jsonResponse({
          data: {
            issues: {
              nodes: [{
                id: 'linear-issue-42',
                identifier: 'LIN-42',
                title: linearRemoteTitle,
                description: 'A stable Linear card',
                priority: 2,
                url: 'https://linear.app/verify-org/issue/LIN-42/pulled-from-linear',
                createdAt: '2026-07-10T08:00:00.000Z',
                updatedAt: '2026-07-10T09:00:00.000Z',
                state: { id: 'state-progress', name: 'In Progress', type: 'started' },
                labels: { nodes: [{ id: 'label-sync', name: 'sync-test' }] },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }

      if (query.includes('ShibaLinearIssueCreate')) {
        const input = (variables.input || {}) as Record<string, unknown>;
        const state = linearStates.get(String(input.stateId || 'state-todo')) || linearStates.get('state-todo')!;
        const createdAt = nextLinearTimestamp();
        linearIssue = {
          id: 'linear-created-84',
          identifier: 'LIN-84',
          title: String(input.title || ''),
          description: String(input.description || ''),
          priority: Number(input.priority || 0),
          url: 'https://linear.app/verify-org/issue/LIN-84/pushed-from-shiba',
          createdAt,
          updatedAt: nextLinearTimestamp(),
          state,
          labels: { nodes: Array.isArray(input.labelIds) && input.labelIds.includes('label-sync')
            ? [{ id: 'label-sync', name: 'sync-test' }]
            : [] },
        };
        return jsonResponse({ data: { issueCreate: { success: true, issue: linearIssue } } });
      }

      if (query.includes('ShibaLinearIssueUpdate')) {
        assert(linearIssue && variables.id === linearIssue.id, 'Linear issue exists before update');
        const input = (variables.input || {}) as Record<string, unknown>;
        const state = linearStates.get(String(input.stateId || linearIssue.state.id)) || linearIssue.state;
        linearIssue = {
          ...linearIssue,
          title: String(input.title ?? linearIssue.title),
          description: String(input.description ?? linearIssue.description),
          priority: Number(input.priority ?? linearIssue.priority),
          updatedAt: nextLinearTimestamp(),
          state,
          labels: input.labelIds === undefined
            ? linearIssue.labels
            : { nodes: Array.isArray(input.labelIds) && input.labelIds.includes('label-sync')
              ? [{ id: 'label-sync', name: 'sync-test' }]
              : [] },
        };
        return jsonResponse({ data: { issueUpdate: { success: true, issue: linearIssue } } });
      }

      return jsonResponse({ errors: [{ message: `Unexpected Linear operation: ${query.slice(0, 80)}` }] }, 400);
    }

    if (url.startsWith('https://verify-shiba.atlassian.net/')) {
      calls.push({ provider: 'jira', url, method, body, authorization: headers.get('authorization') });
      const parsed = new URL(url);
      const route = parsed.pathname;

      if (route === '/rest/api/3/serverInfo' && method === 'GET') {
        return jsonResponse({ baseUrl: 'https://verify-shiba.atlassian.net', deploymentType: 'Cloud' });
      }
      if (route === '/rest/api/3/myself' && method === 'GET') {
        return jsonResponse({ accountId: 'jira-user-1', displayName: 'Jira Verify User', emailAddress: 'verify@example.com', active: true });
      }
      if (route === '/rest/api/3/project/search' && method === 'GET') {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          isLast: true,
          values: [{ id: '10010', key: 'VRFY', name: 'Verify Jira' }],
        });
      }
      if (route === '/rest/agile/1.0/board' && method === 'GET') {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          isLast: true,
          values: [{ id: 77, name: 'Verify Kanban', type: 'kanban', location: { projectId: 10010, projectKey: 'VRFY', projectName: 'Verify Jira' } }],
        });
      }
      if (route === '/rest/api/3/search/jql' && method === 'GET') {
        return jsonResponse({
          isLast: true,
          issues: jiraSearchCreatedIssue && jiraIssue ? [jiraIssue] : [jiraPulledIssue],
        });
      }
      if (route === '/rest/software/1.0/board/77/issue' && method === 'GET') {
        return jsonResponse({ isLast: true, issues: [jiraPulledIssue] });
      }
      if (route === '/rest/api/3/issue' && method === 'POST') {
        const fields = (body?.fields || {}) as Record<string, unknown>;
        jiraIssue = {
          id: '10101',
          key: 'VRFY-1',
          fields: {
            ...fields,
            status: todoStatus,
            created: nextJiraTimestamp(),
            updated: nextJiraTimestamp(),
            project: { id: '10010', key: 'VRFY', name: 'Verify Jira' },
            issuetype: { id: '10001', name: 'Task' },
          },
        };
        return jsonResponse({ id: jiraIssue.id, key: jiraIssue.key, self: `${parsed.origin}/rest/api/3/issue/${jiraIssue.id}` }, 201);
      }
      if (/^\/rest\/api\/3\/issue\/(?:10101|VRFY-1)$/.test(route) && method === 'GET') {
        assert(jiraIssue, 'Jira issue exists before read');
        return jsonResponse(jiraIssue);
      }
      if (/^\/rest\/api\/3\/issue\/(?:10101|VRFY-1)$/.test(route) && method === 'PUT') {
        assert(jiraIssue, 'Jira issue exists before update');
        const fields = (body?.fields || {}) as Record<string, unknown>;
        jiraIssue.fields = { ...jiraIssue.fields, ...fields, updated: nextJiraTimestamp() };
        return new Response(null, { status: 204 });
      }
      if (/^\/rest\/api\/3\/issue\/(?:10101|VRFY-1)\/transitions$/.test(route) && method === 'GET') {
        assert(jiraIssue, 'Jira issue exists before transition discovery');
        const current = jiraIssue.fields.status as { id?: string } | undefined;
        const transition = current?.id === reviewStatus.id
          ? { id: '31', name: 'Done', to: doneStatus }
          : { id: '21', name: 'Review', to: reviewStatus };
        return jsonResponse({ transitions: [transition] });
      }
      if (/^\/rest\/api\/3\/issue\/(?:10101|VRFY-1)\/transitions$/.test(route) && method === 'POST') {
        assert(jiraIssue, 'Jira issue exists before transition');
        if (failJiraTransitions) return jsonResponse({ errorMessages: ['Transition blocked by workflow'] }, 400);
        const transition = (body?.transition || {}) as { id?: string };
        if (transition.id === '21') jiraIssue.fields.status = reviewStatus;
        else if (transition.id === '31') jiraIssue.fields.status = doneStatus;
        else return jsonResponse({ errorMessages: ['Unknown transition'] }, 400);
        jiraIssue.fields.updated = nextJiraTimestamp();
        return new Response(null, { status: 204 });
      }

      return jsonResponse({ errorMessages: [`Unexpected Jira request: ${method} ${route}`] }, 404);
    }

    return jsonResponse({ message: `Unexpected fetch: ${method} ${url}` }, 404);
  }) as typeof fetch;

  try {
    await check('Linear connection and discovery', async () => {
      const linear = await import('../lib/linear');
      const tested = await linear.testLinear(creds);
      assert(tested.ok, `Linear test succeeds: ${tested.error || ''}`);
      assert(tested.user === 'Linear Verify User', 'Linear identity');
      assert(tested.organization === 'Verify Org', 'Linear organization');
      const targets = await linear.linearDiscoverTargets(creds);
      assert(targets.length === 1, 'one Linear team discovered');
      assert(targets[0].id === 'team-verify-1' && targets[0].kind === 'team', 'Linear target shape');
      const auth = calls.find((call) => call.provider === 'linear')?.authorization;
      assert(auth === linearSecret, 'personal API key sent raw in Authorization header');
    });

    await check('Linear pull is idempotent', async () => {
      const sync = await import('../lib/board-sync');
      const board = await import('../lib/board');
      const target = { provider: 'linear' as const, id: 'team-verify-1', key: 'LIN', name: 'Verify Linear', kind: 'team' as const };
      const first = await sync.syncBoard({ provider: 'linear', target, direction: 'pull', mode: 'board', creds });
      assert(first.ok && first.imported === 1, `first Linear pull imports one: ${JSON.stringify(first)}`);
      let tasks = await board.listBoardTasks();
      assert(tasks.length === 1, 'one local card after first pull');
      assert(tasks[0].title === 'Pulled from Linear' && tasks[0].status === 'in_progress', 'Linear fields normalized');
      assert(tasks[0].externalRefs?.[0]?.remoteId === 'linear-issue-42', 'Linear remote link persisted');

      const second = await sync.syncBoard({ provider: 'linear', target, direction: 'pull', mode: 'board', creds });
      assert(second.ok && second.imported === 0 && second.updatedLocal === 0 && second.skipped === 1, 'second Linear pull skips unchanged card');
      tasks = await board.listBoardTasks();
      assert(tasks.length === 1, 'idempotent pull does not duplicate cards');
      const state = await board.getBoardSyncState();
      assert(state?.linear?.skipped === 1, 'Linear last-sync state persisted');

      linearRemoteTitle = 'Remote edit during sync';
      linearConcurrentEdit = true;
      const guarded = await sync.syncBoard({ provider: 'linear', target, direction: 'pull', mode: 'board', creds });
      assert(!guarded.ok && guarded.errors.length === 1, 'concurrent Board edit is reported instead of overwritten');
      tasks = await board.listBoardTasks();
      assert(tasks[0].title === 'Local edit during sync', 'concurrent local edit survives the pull');
      linearRemoteTitle = 'Pulled from Linear';

      // Leave the shared Board empty for the independent Jira push scenario.
      await board.deleteBoardTask(tasks[0].id);
    });

    await check('Linear push, update, and status mapping', async () => {
      const sync = await import('../lib/board-sync');
      const board = await import('../lib/board');
      const target = { provider: 'linear' as const, id: 'team-verify-1', key: 'LIN', name: 'Verify Linear', kind: 'team' as const };
      const local = await board.createBoardTask({
        title: 'Push this card to Linear',
        description: 'Linear push verification',
        status: 'in_review',
        priority: 3,
        labels: ['sync-test'],
        createdBy: 'board sync verifier',
      });
      const first = await sync.syncBoard({ provider: 'linear', target, direction: 'push', mode: 'board', creds });
      assert(first.ok && first.exported === 1, `Linear creates one issue: ${JSON.stringify(first)}`);
      assert(linearIssue?.identifier === 'LIN-84', 'Linear issue created');
      assert(String(linearIssue?.state.id) === 'state-review', 'Linear new issue uses review workflow state');
      let stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.some((ref) => ref.provider === 'linear' && ref.remoteId === 'linear-created-84'), 'Linear link persisted');

      await board.updateBoardTask(local.id, { title: 'Updated Linear card', status: 'done', actor: 'board sync verifier' });
      const second = await sync.syncBoard({ provider: 'linear', target, direction: 'push', mode: 'board', creds });
      assert(second.ok && second.updatedRemote === 1, `Linear update pushed: ${JSON.stringify(second)}`);
      assert(linearIssue?.title === 'Updated Linear card', 'Linear title updated');
      assert(String(linearIssue?.state.id) === 'state-done', 'Linear status updated');
      assert(linearIssue?.description === 'Linear push verification', 'unchanged Linear description preserved by partial update');
      const linearUpdate = calls.find((call) =>
        call.provider === 'linear' && String(call.body?.query || '').includes('ShibaLinearIssueUpdate'),
      );
      const linearUpdateInput = ((linearUpdate?.body?.variables as Record<string, unknown> | undefined)?.input || {}) as Record<string, unknown>;
      assert(!('description' in linearUpdateInput) && !('labelIds' in linearUpdateInput) && !('priority' in linearUpdateInput), 'Linear update omits unchanged fields');

      const third = await sync.syncBoard({ provider: 'linear', target, direction: 'push', mode: 'board', creds });
      assert(third.ok && third.updatedRemote === 0 && third.skipped === 1, 'unchanged Linear card is skipped');
      await board.updateBoardTask(local.id, { title: 'Linear task-only update', actor: 'board sync verifier' });
      const modeSwitch = await sync.syncBoard({ provider: 'linear', target, direction: 'push', mode: 'tasks', creds });
      assert(modeSwitch.ok && modeSwitch.updatedRemote === 1, 'board-to-task mode switch pushes the real local edit');
      const lastLinearUpdate = calls.filter((call) =>
        call.provider === 'linear' && String(call.body?.query || '').includes('ShibaLinearIssueUpdate'),
      ).at(-1);
      const modeSwitchInput = ((lastLinearUpdate?.body?.variables as Record<string, unknown> | undefined)?.input || {}) as Record<string, unknown>;
      assert(Object.keys(modeSwitchInput).join(',') === 'title', 'mode switch does not resend unchanged Linear fields');
      stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.find((ref) => ref.provider === 'linear')?.remoteKey === 'LIN-84', 'Linear key remains linked');
      await board.deleteBoardTask(local.id);
    });

    await check('Jira connection and discovery', async () => {
      const jira = await import('../lib/jira');
      const tested = await jira.testJira(creds);
      assert(tested.ok, `Jira test succeeds: ${tested.error || ''}`);
      assert(tested.user === 'Jira Verify User', 'Jira identity');
      assert(tested.projects?.[0]?.key === 'VRFY', 'Jira project connection data');
      assert(tested.boards?.[0]?.id === 77, 'Jira Kanban connection data');
      const targets = await jira.jiraDiscoverTargets(creds);
      assert(targets.some((target) => target.id === 'project:VRFY'), 'Jira project target discovered');
      assert(targets.some((target) => target.id === 'board:77'), 'Jira board target discovered');
      const auth = calls.find((call) => call.provider === 'jira')?.authorization;
      const expected = `Basic ${Buffer.from(`verify@example.com:${jiraSecret}`, 'utf8').toString('base64')}`;
      assert(auth === expected, 'Jira sends email + API token as Basic auth');
    });

    await check('Jira pull is idempotent', async () => {
      const sync = await import('../lib/board-sync');
      const board = await import('../lib/board');
      const target = {
        provider: 'jira' as const,
        id: 'project:VRFY',
        key: 'VRFY',
        name: 'Verify Jira',
        projectKey: 'VRFY',
        projectName: 'Verify Jira',
        kind: 'project' as const,
      };
      const first = await sync.syncBoard({ provider: 'jira', target, direction: 'pull', mode: 'board', creds });
      assert(first.ok && first.imported === 1, `first Jira pull imports one: ${JSON.stringify(first)}`);
      let tasks = await board.listBoardTasks();
      assert(tasks.length === 1, 'one local card after Jira pull');
      assert(tasks[0].title === 'Pulled from Jira' && tasks[0].status === 'in_review', 'Jira fields normalized');
      assert(tasks[0].externalRefs?.[0]?.remoteId === '10084', 'Jira remote link persisted');

      const second = await sync.syncBoard({ provider: 'jira', target, direction: 'pull', mode: 'board', creds });
      assert(second.ok && second.imported === 0 && second.updatedLocal === 0 && second.skipped === 1, 'second Jira pull skips unchanged card');
      tasks = await board.listBoardTasks();
      assert(tasks.length === 1, 'idempotent Jira pull does not duplicate cards');
      assert(/^jira-[a-f0-9]{20}$/.test(tasks[0].externalRefs?.[0]?.connectionId || ''), 'Jira link is namespaced to its site');

      const tasksMode = await sync.syncBoard({ provider: 'jira', target, direction: 'bidirectional', mode: 'tasks', creds });
      assert(tasksMode.ok && tasksMode.conflicts === 0, 'switching to task-only mode does not manufacture a conflict');
      const boardMode = await sync.syncBoard({ provider: 'jira', target, direction: 'bidirectional', mode: 'board', creds });
      assert(boardMode.ok && boardMode.conflicts === 0, 'switching back to board mode re-baselines equal statuses');
      tasks = await board.listBoardTasks();
      const localBaselineBeforeRebind = tasks[0].externalRefs?.[0]?.lastLocalFieldFingerprints?.title;
      await board.updateBoardTask(tasks[0].id, { title: 'Unsynced title before target switch', actor: 'board sync verifier' });

      const boardTarget = {
        ...target,
        id: 'board:77',
        name: 'Verify Kanban',
        kind: 'board' as const,
      };
      const rebound = await sync.syncBoard({ provider: 'jira', target: boardTarget, direction: 'pull', mode: 'board', creds });
      assert(rebound.ok && rebound.imported === 0, 'overlapping Jira board reuses the existing issue link');
      tasks = await board.listBoardTasks();
      assert(tasks.length === 1, 'switching project to overlapping Kanban target does not duplicate the card');
      assert(tasks[0].externalRefs?.[0]?.containerId === 'board:77', 'Jira link rebinds to the selected Kanban target');
      assert(tasks[0].title === 'Unsynced title before target switch', 'target rebind preserves an unsynced local edit');
      assert(tasks[0].externalRefs?.[0]?.lastLocalFieldFingerprints?.title === localBaselineBeforeRebind, 'target rebind preserves the prior local baseline');
      await board.deleteBoardTask(tasks[0].id);
    });

    await check('Jira push, update, and status transitions', async () => {
      const sync = await import('../lib/board-sync');
      const board = await import('../lib/board');
      const local = await board.createBoardTask({
        title: 'Push this card to Jira',
        description: 'Jira push verification',
        status: 'in_review',
        priority: 2,
        labels: ['sync-test'],
        createdBy: 'board sync verifier',
      });
      const target = {
        provider: 'jira' as const,
        id: 'project:VRFY',
        key: 'VRFY',
        name: 'Verify Jira',
        projectKey: 'VRFY',
        projectName: 'Verify Jira',
        kind: 'project' as const,
      };

      const first = await sync.syncBoard({ provider: 'jira', target, direction: 'push', mode: 'board', creds });
      assert(first.ok && first.exported === 1, `Jira creates one issue: ${JSON.stringify(first)}`);
      assert(jiraIssue?.key === 'VRFY-1', 'Jira issue created');
      assert((jiraIssue?.fields.status as { id?: string } | undefined)?.id === reviewStatus.id, 'Jira transitioned new issue to review');
      let stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.some((ref) => ref.provider === 'jira' && ref.remoteId === '10101'), 'Jira link persisted');

      jiraSearchCreatedIssue = true;
      jiraIssue.fields.labels = ['sync-test', 'remote-only'];
      jiraIssue.fields.updated = nextJiraTimestamp();
      await board.updateBoardTask(local.id, { title: 'Updated Jira card', status: 'done', actor: 'board sync verifier' });
      const second = await sync.syncBoard({ provider: 'jira', target, direction: 'bidirectional', mode: 'board', creds });
      assert(second.ok && second.updatedRemote === 1 && second.updatedLocal === 1 && second.conflicts === 0, `Jira disjoint changes merged: ${JSON.stringify(second)}`);
      assert(jiraIssue?.fields.summary === 'Updated Jira card', 'Jira summary updated');
      assert((jiraIssue?.fields.status as { id?: string } | undefined)?.id === doneStatus.id, 'Jira transitioned updated issue to done');
      const jiraUpdate = calls.find((call) =>
        call.provider === 'jira'
        && call.method === 'PUT'
        && /\/rest\/api\/3\/issue\/(?:10101|VRFY-1)$/.test(new URL(call.url).pathname),
      );
      const jiraUpdateFields = (jiraUpdate?.body?.fields || {}) as Record<string, unknown>;
      assert(!('description' in jiraUpdateFields) && !('labels' in jiraUpdateFields) && !('priority' in jiraUpdateFields), 'Jira update omits unchanged rich fields');
      stored = await board.getBoardTask(local.id);
      assert(stored?.labels.includes('remote-only'), 'remote-only Jira labels merge back into Shiba');

      const third = await sync.syncBoard({ provider: 'jira', target, direction: 'push', mode: 'board', creds });
      assert(third.ok && third.updatedRemote === 0 && third.skipped === 1, 'unchanged Jira card is skipped');
      stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.find((ref) => ref.provider === 'jira')?.remoteKey === 'VRFY-1', 'Jira key remains linked');

      const jiraCalls = calls.filter((call) => call.provider === 'jira');
      assert(jiraCalls.some((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue')), 'Jira create request observed');
      assert(jiraCalls.some((call) => call.method === 'PUT' && /\/rest\/api\/3\/issue\/(?:10101|VRFY-1)$/.test(new URL(call.url).pathname)), 'Jira update request observed');
      assert(jiraCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/transitions')).length === 2, 'two Jira status transitions observed');
      jiraSearchCreatedIssue = false;
      await board.deleteBoardTask(local.id);
    });

    await check('Jira post-create failures keep the remote link', async () => {
      const sync = await import('../lib/board-sync');
      const board = await import('../lib/board');
      const target = {
        provider: 'jira' as const,
        id: 'project:VRFY',
        key: 'VRFY',
        name: 'Verify Jira',
        projectKey: 'VRFY',
        projectName: 'Verify Jira',
        kind: 'project' as const,
      };
      jiraIssue = null;
      failJiraTransitions = true;
      const createsBefore = calls.filter((call) => call.provider === 'jira' && call.method === 'POST' && call.url.endsWith('/rest/api/3/issue')).length;
      const local = await board.createBoardTask({
        title: 'Jira transition failure',
        status: 'cancelled',
        createdBy: 'board sync verifier',
      });
      const first = await sync.syncBoard({ provider: 'jira', target, direction: 'push', mode: 'board', creds });
      assert(!first.ok && first.exported === 1 && first.errors.length === 1, 'post-create transition failure is reported as a partial sync');
      let stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.some((ref) => ref.provider === 'jira' && ref.remoteId === '10101'), 'Jira ID is linked before the failed transition');

      const second = await sync.syncBoard({ provider: 'jira', target, direction: 'push', mode: 'board', creds });
      assert(!second.ok && second.exported === 0 && second.errors.length === 1, 'retry updates the linked issue instead of creating another');
      const createsAfter = calls.filter((call) => call.provider === 'jira' && call.method === 'POST' && call.url.endsWith('/rest/api/3/issue')).length;
      assert(createsAfter === createsBefore + 1, 'transition retries never duplicate the Jira issue');
      stored = await board.getBoardTask(local.id);
      assert(stored?.externalRefs?.[0]?.lastLocalFingerprint === '', 'pending status remains eligible for retry');
      failJiraTransitions = false;
      await board.deleteBoardTask(local.id);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const summary = `${passed} passed, 0 failed`;
  log(`PASS: Linear/Jira Board sync verified (${summary})`);
  await fs.writeFile(LOG, lines.join('\n') + '\n');
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log(`FAIL: ${message}`);
  log(`${passed} passed, 1 failed`);
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(LOG, lines.join('\n') + '\n').catch(() => {});
  process.exit(1);
});
