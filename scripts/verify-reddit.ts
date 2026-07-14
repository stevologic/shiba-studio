import './verify-isolate'; // MUST be first: checks must never touch the live Studio store.

/** Focused regression harness for the Reddit Devvit core integration. */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import type { Agent, AgentRun, IntegrationCreds } from '../lib/types';

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(SCRATCH, 'reddit-verify.log');

let passed = 0;
const lines: string[] = [];

function log(message: string): void {
  lines.push(message);
  console.log(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  passed++;
  log(`ok: ${message}`);
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function expectReject(
  operation: () => Promise<unknown>,
  messagePart: string,
  label: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  assert(!!error, `${label} rejects`);
  assert(message.toLowerCase().includes(messagePart.toLowerCase()), `${label} explains the failure`);
}

function expectThrow(operation: () => unknown, messagePart: string, label: string): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  assert(!!error, `${label} rejects`);
  assert(message.toLowerCase().includes(messagePart.toLowerCase()), `${label} explains the failure`);
}

function redditCreds(name: string): IntegrationCreds {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return {
    reddit: {
      devvitEndpoint: `https://verify-${slug}-external.devvit.net`,
      devvitAppToken: `devvit_at_verify_${slug}_12345678`,
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect?: RequestRedirect;
}

type Scenario =
  | 'normal'
  | 'read-error'
  | 'bad-protocol'
  | 'missing-capabilities'
  | 'oversized'
  | 'invalid-listing-community'
  | 'mismatched-listing-community'
  | 'mismatched-post-community'
  | 'submit-error'
  | 'submit-ambiguous'
  | 'invalid-receipt'
  | 'submit-fullname-mismatch'
  | 'submit-subreddit-mismatch'
  | 'submit-permalink-id-mismatch'
  | 'submit-permalink-community-mismatch';

function statusPayload() {
  return {
    ok: true,
    protocolVersion: 1,
    provider: 'devvit',
    app: { slug: 'shiba-rdt-bridge', account: 'shiba_bridge_app', accountId: 't2_app123' },
    installation: { subreddit: 'testing', subredditId: 't5_test123' },
    capabilities: ['read_posts', 'submit_post'],
  };
}

function listingPayload() {
  return {
    ok: true,
    protocolVersion: 1,
    subreddit: 'testing',
    posts: [{
      id: 'post123',
      fullname: 't3_post123',
      subreddit: 'testing',
      title: 'A useful type-system idea',
      author: 'verify_author',
      selfText: 'A compact but interesting body.',
      url: 'https://example.com/type-system',
      permalink: 'https://www.reddit.com/r/testing/comments/post123/a_useful_type_system_idea/',
      score: 321,
      comments: 45,
      createdAt: '2023-11-14T22:13:20.000Z',
      nsfw: false,
      spoiler: true,
      isSelf: false,
    }],
    nextAfter: 't3_next123',
  };
}

function submitPayload() {
  return {
    ok: true,
    protocolVersion: 1,
    id: 'confirmed42',
    fullname: 't3_confirmed42',
    url: 'https://www.reddit.com/r/testing/comments/confirmed42/interesting/',
    subreddit: 'testing',
    title: 'Interesting',
    author: 'shiba_bridge_app',
  };
}

async function verifyStructuralWiring(): Promise<void> {
  const catalog = await import('../lib/integration-catalog');
  assert(catalog.INTEGRATION_IDS.includes('reddit'), 'integration catalog includes Reddit');
  assert(catalog.AGENT_INTEGRATION_IDS.includes('reddit'), 'Reddit remains agent-scoped');
  const meta = catalog.getIntegrationMeta('reddit');
  assert(meta?.label === 'Reddit Devvit', 'catalog identifies the Devvit transport');
  assert(meta?.docsUrl?.includes('developers.reddit.com/docs/capabilities/server/external-endpoints') === true, 'catalog links official External Endpoints docs');
  assert(meta?.setupLabel === 'Create Devvit app', 'catalog labels the Reddit app-creation link accurately');
  assert((await read('public/integrations/reddit.svg')).includes('<svg'), 'Reddit integration icon exists');

  const types = await read('lib/types.ts');
  const redditType = types.match(/reddit\?:\s*\{([\s\S]*?)\}\s*;\s*obsidian\?:/)?.[1] || '';
  assert(redditType.includes('devvitEndpoint?: string'), 'credential type stores the Devvit endpoint');
  assert(redditType.includes('devvitAppToken?: string'), 'credential type stores the managed app token');
  assert(!/(?:clientSecret|accessToken|refreshToken|username)/.test(redditType), 'credential type contains no legacy Reddit OAuth session');

  const { EMPTY_INTEGRATION_SCOPE } = await import('../lib/types');
  const { getToolDefinitions } = await import('../lib/agent-runtime');
  const without = getToolDefinitions({ ...EMPTY_INTEGRATION_SCOPE }, false);
  const withReddit = getToolDefinitions({ ...EMPTY_INTEGRATION_SCOPE, reddit: true }, false);
  assert(!without.some((tool) => tool.function.name.startsWith('reddit_')), 'Reddit tools are hidden when scope is off');
  assert(withReddit.some((tool) => tool.function.name === 'reddit_read_posts'), 'Reddit read tool is registered');
  const submitTool = withReddit.find((tool) => tool.function.name === 'reddit_submit');
  assert(!!submitTool, 'Reddit submit tool is registered');
  const submitSchema = submitTool.function.parameters as { required?: string[] };
  assert(submitSchema.required?.includes('subreddit') && submitSchema.required.includes('title'), 'Reddit submit requires community and title');

  const { APPROVAL_GATED_TOOLS, toolNeedsApproval } = await import('../lib/tool-approval');
  assert(APPROVAL_GATED_TOOLS.has('reddit_submit'), 'Reddit submission remains approval-gated');
  assert(toolNeedsApproval('reddit_submit', 'ask'), 'Ask mode requires exact Reddit approval');
  assert(!toolNeedsApproval('reddit_read_posts', 'ask'), 'Reddit reads do not require approval');

  const { mergeAgentIntegrationCreds } = await import('../lib/integrations');
  const globalCreds = redditCreds('global');
  const endpointOnly = mergeAgentIntegrationCreds(globalCreds, {
    reddit: { devvitEndpoint: 'https://verify-agent-external.devvit.net' },
  });
  assert(endpointOnly.reddit?.devvitEndpoint?.includes('verify-agent'), 'agent endpoint override wins');
  assert(!endpointOnly.reddit?.devvitAppToken, 'agent endpoint never borrows the global token');
  const tokenOnly = mergeAgentIntegrationCreds(globalCreds, {
    reddit: { devvitAppToken: 'devvit_at_agent_override_12345678' },
  });
  assert(tokenOnly.reddit?.devvitAppToken?.includes('agent_override'), 'agent token override wins');
  assert(!tokenOnly.reddit?.devvitEndpoint, 'agent token never borrows the global endpoint');
  const complete = mergeAgentIntegrationCreds(globalCreds, redditCreds('agent-complete'));
  assert(complete.reddit?.devvitEndpoint?.includes('agent-complete'), 'complete agent pair replaces the global pair');

  const { redditOverridePairError } = await import('../lib/integration-validation');
  assert(redditOverridePairError(undefined) === null, 'missing agent Reddit override uses the global connection');
  assert(redditOverridePairError({ reddit: {} }) === null, 'blank agent Reddit override uses the global connection');
  assert(redditOverridePairError(redditCreds('pair-validation')) === null, 'complete agent Reddit override is accepted');
  assert(!!redditOverridePairError({ reddit: { devvitEndpoint: 'https://verify-partial-external.devvit.net' } }), 'endpoint-only agent Reddit override is rejected');
  assert(!!redditOverridePairError({ reddit: { devvitAppToken: 'devvit_at_partial_12345678' } }), 'token-only agent Reddit override is rejected');
  const agentsApi = await import('../app/api/agents/route');
  for (const [body, label] of [
    [{ name: 'Partial Reddit Create', integrationOverrides: { reddit: { devvitEndpoint: 'https://verify-partial-external.devvit.net' } } }, 'create'],
    [{ action: 'update', agent: { id: 'missing-agent', integrationOverrides: { reddit: { devvitAppToken: 'devvit_at_partial_12345678' } } } }, 'update'],
  ] as const) {
    const response = await agentsApi.POST(new NextRequest('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const payload = await response.json() as { error?: string };
    assert(response.status === 400 && payload.error?.includes('require both'), `agent API rejects a partial Reddit override on ${label}`);
  }

  const companionConfig = await read('devvit/reddit-bridge/devvit.json');
  const companionServer = `${await read('devvit/reddit-bridge/src/server/index.ts')}\n${await read('devvit/reddit-bridge/src/server/app.ts')}`;
  assert(companionConfig.includes('"externalEndpoints"') && companionConfig.includes('"reddit"'), 'Devvit manifest declares endpoints and Reddit permission');
  assert(companionServer.includes("'/external/shiba/status'") && companionServer.includes("'/external/shiba/posts/read'") && companionServer.includes("'/external/shiba/posts/submit'"), 'companion exposes only fixed Shiba routes');
  assert(companionServer.includes("runAs: 'APP'"), 'automated submissions run as the Devvit app account');
  assert(companionServer.includes('body.protocolVersion !== PROTOCOL_VERSION'), 'companion rejects incompatible protocol versions');
  assert(companionServer.includes('This Devvit installation is scoped to r/'), 'companion enforces installation scope');

  const shell = await read('components/shiba-studio.tsx');
  assert(shell.includes("key: 'devvitEndpoint'") && shell.includes("key: 'devvitAppToken'"), 'agent editor exposes the Devvit credential pair');
  assert(shell.includes('Reddit overrides are one credential pair') && shell.includes('A partial pair is rejected'), 'agent editor explains Reddit override pair semantics');
  assert(shell.includes('redditOverridePairError(agentForm.integrationOverrides)'), 'agent editor validates the Reddit override pair before saving');
  assert(shell.includes('External Endpoints are currently a limited-access Devvit capability'), 'integration UI explains the limited-access prerequisite');
  assert(shell.includes("const saved = await saveIntegration(which, { silent: true })") && shell.includes("body: JSON.stringify({ action: 'test', which })"), 'connection tests persist the draft then probe server-stored credentials');
  assert(shell.includes('onChangeCapture={() => invalidateIntegrationTest(integration.id)}'), 'credential edits invalidate prior connection results');
  assert(shell.includes('integrationDraftVersionsRef.current[which] !== draftVersion'), 'late connection-test results are fenced from newer edits');
  assert(!shell.includes('/api/reddit-oauth/'), 'integration UI contains no Reddit OAuth popup routes');
  assert(!(await exists('lib/reddit-oauth.ts')), 'legacy Reddit OAuth implementation is removed');
  assert(!(await exists('app/api/reddit-oauth/start/route.ts')), 'legacy Reddit OAuth start route is removed');
  assert(!(await exists('app/api/reddit-oauth/callback/route.ts')), 'legacy Reddit OAuth callback route is removed');
  const integrationRoute = await read('app/api/integrations/route.ts');
  assert(!integrationRoute.includes('disconnect-reddit') && !integrationRoute.includes('reddit-oauth'), 'generic integration API contains no OAuth lifecycle branch');
  const agentsRoute = await read('app/api/agents/route.ts');
  assert(agentsRoute.includes('redditOverridePairError(body.agent?.integrationOverrides)') && agentsRoute.includes('redditOverridePairError(body.integrationOverrides)'), 'agent API rejects partial Reddit override pairs on update and create');
  const loopback = await read('lib/oauth-loopback.ts');
  assert(!loopback.includes('shiba-reddit'), 'OAuth hand-back channels contain no orphaned Reddit browser flow');
  const privacy = await read('PRIVACY.md');
  assert(privacy.includes('Reddit') && privacy.includes('Devvit companion endpoint') && privacy.includes('post content'), 'privacy notice explains Reddit Devvit data flow');
  const apiDocs = `${await read('docs/api.md')}\n${await read('app/api-docs/page.tsx')}`;
  assert(apiDocs.includes('secret fields masked'), 'API docs accurately describe masked integration credentials');

  const context = await read('lib/integration-context.ts');
  assert(context.includes('Connected through Devvit as app account'), 'agent context identifies app-account authorship');
  assert(context.includes('untrusted external content'), 'agent context treats Reddit posts as untrusted data');
}

async function verifyTransportAndRuntime(tempDir: string): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  let scenario: Scenario = 'normal';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string' && init.body) body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({
      url,
      method: (init?.method || 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body,
      redirect: init?.redirect,
    });
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('-external.devvit.net')) return jsonResponse({ error: 'unexpected host' }, 404);
    if (parsed.pathname === '/external/shiba/status') {
      if (scenario === 'oversized') return new Response('x'.repeat(1_000_001), { status: 200 });
      if (scenario === 'missing-capabilities') {
        return jsonResponse({ ...statusPayload(), capabilities: ['read_posts'] });
      }
      return jsonResponse(scenario === 'bad-protocol' ? { ...statusPayload(), protocolVersion: 2 } : statusPayload());
    }
    if (parsed.pathname === '/external/shiba/posts/read') {
      if (scenario === 'read-error') return jsonResponse({ ok: false, error: 'listing temporarily unavailable' }, 503);
      if (scenario === 'bad-protocol') return jsonResponse({ ...listingPayload(), protocolVersion: 2 });
      if (scenario === 'invalid-listing-community') return jsonResponse({ ...listingPayload(), subreddit: 'not/a/community' });
      if (scenario === 'mismatched-listing-community') return jsonResponse({ ...listingPayload(), subreddit: 'elsewhere' });
      if (scenario === 'mismatched-post-community') {
        const payload = listingPayload();
        return jsonResponse({ ...payload, posts: payload.posts.map((post) => ({ ...post, subreddit: 'elsewhere' })) });
      }
      return jsonResponse(listingPayload());
    }
    if (parsed.pathname === '/external/shiba/posts/submit') {
      if (scenario === 'submit-ambiguous') throw new TypeError('socket closed after request write');
      if (scenario === 'submit-error') return jsonResponse({ ok: false, error: 'submission unavailable' }, 503);
      if (scenario === 'invalid-receipt') return jsonResponse({ ok: true, protocolVersion: 1, id: 'missing-confirmation' });
      if (scenario === 'submit-fullname-mismatch') return jsonResponse({ ...submitPayload(), fullname: 't3_another42' });
      if (scenario === 'submit-subreddit-mismatch') return jsonResponse({ ...submitPayload(), subreddit: 'elsewhere' });
      if (scenario === 'submit-permalink-id-mismatch') {
        return jsonResponse({ ...submitPayload(), url: 'https://www.reddit.com/r/testing/comments/another42/interesting/' });
      }
      if (scenario === 'submit-permalink-community-mismatch') {
        return jsonResponse({ ...submitPayload(), url: 'https://www.reddit.com/r/elsewhere/comments/confirmed42/interesting/' });
      }
      return jsonResponse(submitPayload());
    }
    return jsonResponse({ error: `unexpected route ${parsed.pathname}` }, 404);
  }) as typeof fetch;

  const reddit = await import('../lib/reddit');
  try {
    const invalidEndpoints = [
      ['http://verify-external.devvit.net', 'HTTPS'],
      ['https://evil.example', 'official'],
      ['https://safe-external.devvit.net.evil.example', 'official'],
      ['https://user@safe-external.devvit.net', 'credentials'],
      ['https://safe-external.devvit.net:444', 'port'],
      ['https://safe-external.devvit.net/external/shiba/status', 'origin'],
      ['https://safe-external.devvit.net?next=evil', 'query'],
    ] as const;
    for (const [endpoint, message] of invalidEndpoints) {
      expectThrow(() => reddit.normalizeRedditDevvitEndpoint(endpoint), message, `unsafe endpoint ${endpoint}`);
    }

    calls.length = 0;
    scenario = 'normal';
    const status = await reddit.getRedditDevvitStatus(redditCreds('status'));
    assert(status.appAccount === 'shiba_bridge_app' && status.subreddit === 'testing', 'status returns app account and installed community');
    const statusCall = calls[0];
    assert(statusCall.url === 'https://verify-status-external.devvit.net/external/shiba/status', 'status uses the fixed official route');
    assert(statusCall.method === 'POST' && statusCall.redirect === 'error', 'bridge calls use POST and reject redirects');
    assert(statusCall.headers.get('authorization') === 'Bearer devvit_at_verify_status_12345678', 'bridge sends the managed token only in Authorization');
    assert(statusCall.body.protocolVersion === 1, 'bridge call declares protocol version 1');

    calls.length = 0;
    const listing = await reddit.redditReadPosts({
      subreddit: 'https://www.reddit.com/r/testing/',
      sort: 'top',
      time: 'week',
      limit: 999,
      after: 't3_cursor123',
    }, redditCreds('read'));
    assert(listing.posts.length === 1 && listing.nextAfter === 't3_next123', 'read returns normalized posts and cursor');
    assert(listing.posts[0].createdAt === '2023-11-14T22:13:20.000Z', 'read retains a validated ISO timestamp');
    const readCall = calls[0];
    assert(new URL(readCall.url).pathname === '/external/shiba/posts/read', 'read uses the fixed bridge route');
    assert(readCall.body.subreddit === 'testing' && readCall.body.sort === 'top' && readCall.body.time === 'week', 'read normalizes community and listing options');
    assert(readCall.body.limit === 25 && readCall.body.after === 't3_cursor123', 'read clamps limits and forwards a validated cursor');

    calls.length = 0;
    await reddit.redditReadPosts({}, redditCreds('installed-default'));
    assert(!Object.prototype.hasOwnProperty.call(calls[0].body, 'subreddit'), 'omitted community delegates to the Devvit installation');
    const beforeInvalidCursor = calls.length;
    await expectReject(
      () => reddit.redditReadPosts({ after: '../escape' }, redditCreds('invalid-cursor')),
      'pagination cursor',
      'invalid read cursor',
    );
    assert(calls.length === beforeInvalidCursor, 'invalid cursor is rejected before network access');

    for (const [failure, message] of [
      ['invalid-listing-community', 'invalid listing community'],
      ['mismatched-listing-community', 'different community'],
      ['mismatched-post-community', 'outside the confirmed community'],
    ] as const) {
      scenario = failure;
      calls.length = 0;
      await expectReject(
        () => reddit.redditReadPosts({ subreddit: 'testing' }, redditCreds(failure)),
        message,
        failure,
      );
      assert(calls.length === 1, `${failure} is rejected after one listing request`);
    }

    scenario = 'read-error';
    calls.length = 0;
    await expectReject(() => reddit.redditReadPosts({}, redditCreds('read-error')), 'temporarily unavailable', 'bridge read error');
    assert(calls.length === 1, 'failed read is not multiplied by hidden retries');

    scenario = 'bad-protocol';
    calls.length = 0;
    await expectReject(() => reddit.getRedditDevvitStatus(redditCreds('protocol')), 'Unsupported Reddit Devvit bridge protocol', 'incompatible bridge');
    assert(calls.length === 1, 'incompatible bridge is rejected after one request');

    scenario = 'missing-capabilities';
    calls.length = 0;
    await expectReject(
      () => reddit.getRedditDevvitStatus(redditCreds('missing-capabilities')),
      'required read and submit capabilities',
      'missing Devvit capabilities',
    );
    assert(calls.length === 1, 'missing Devvit capabilities are rejected after one request');

    scenario = 'oversized';
    calls.length = 0;
    await expectReject(() => reddit.getRedditDevvitStatus(redditCreds('oversized')), 'size limit', 'oversized bridge response');
    assert(calls.length === 1, 'oversized bridge response is stopped after one request');

    scenario = 'normal';
    calls.length = 0;
    const submitted = await reddit.redditSubmit({
      subreddit: '/r/testing/',
      title: '  Interesting  ',
      kind: 'link',
      url: 'https://example.com/interesting?source=verify',
      nsfw: true,
      spoiler: false,
      sendReplies: false,
    }, redditCreds('submit'));
    assert(submitted.ok && submitted.id === 'confirmed42' && submitted.author === 'shiba_bridge_app', 'submit returns the authoritative Devvit receipt');
    assert(calls.length === 1, 'successful submission sends exactly one request');
    const submitCall = calls[0];
    assert(new URL(submitCall.url).pathname === '/external/shiba/posts/submit', 'submit uses the fixed bridge route');
    assert(submitCall.body.kind === 'link' && submitCall.body.subreddit === 'testing', 'submit maps kind and installed community');
    assert(submitCall.body.url === 'https://example.com/interesting?source=verify' && submitCall.body.sendReplies === false, 'submit preserves validated link options');

    for (const [failure, message] of [
      ['submit-error', 'submission unavailable'],
      ['submit-ambiguous', 'socket closed'],
      ['invalid-receipt', 'authoritative'],
      ['submit-fullname-mismatch', 'authoritative'],
      ['submit-subreddit-mismatch', 'different community'],
      ['submit-permalink-id-mismatch', 'does not match'],
      ['submit-permalink-community-mismatch', 'does not match'],
    ] as const) {
      scenario = failure;
      calls.length = 0;
      await expectReject(
        () => reddit.redditSubmit({ subreddit: 'testing', title: 'Never duplicate', text: 'body' }, redditCreds(failure)),
        message,
        failure,
      );
      assert(calls.length === 1, `${failure} never retries an ambiguous write`);
    }

    scenario = 'normal';
    calls.length = 0;
    const { EMPTY_INTEGRATION_SCOPE } = await import('../lib/types');
    const { executeAgentTool } = await import('../lib/agent-tool-exec');
    const now = new Date().toISOString();
    const agent: Agent = {
      id: 'reddit-verify-agent',
      name: 'Reddit Verify',
      model: 'grok-verify',
      autoAcceptBoardAssignments: false,
      workspace: { path: ROOT, useWorktree: false },
      integrations: { ...EMPTY_INTEGRATION_SCOPE, reddit: true },
      peers: [],
      createdAt: now,
      updatedAt: now,
    };
    const run: Partial<AgentRun> = { id: 'reddit-verify-run', status: 'running' };
    const denied = await executeAgentTool(
      'reddit_submit',
      { subreddit: 'testing', title: 'Must not post', text: 'body' },
      agent,
      run,
      ROOT,
      undefined,
      redditCreds('denied'),
    );
    assert((denied.result as { denied?: boolean }).denied === true, 'executor denies Reddit submit without runtime authorization');
    assert(calls.length === 0, 'denied executor submission performs no network request');

    const authorized = await executeAgentTool(
      'reddit_submit',
      { subreddit: 'testing', title: 'Interesting', text: 'body' },
      agent,
      run,
      ROOT,
      undefined,
      redditCreds('executor'),
      undefined,
      { redditSubmitAuthorized: true },
    );
    assert((authorized.result as { id?: string }).id === 'confirmed42', 'executor accepts its explicit Reddit authorization capability');
    assert(Number(calls.length) === 1, 'authorized executor submission sends one request');
    assert(calls[0].headers.get('authorization') === 'Bearer devvit_at_verify_executor_12345678', 'executor uses its scoped Devvit credential pair');

    const { setPersistenceDataDir, saveConfig } = await import('../lib/persistence');
    setPersistenceDataDir(tempDir);
    await saveConfig({
      xaiApiKey: 'verify-xai-key',
      integrations: redditCreds('global-runtime'),
      disabledTools: [],
    });

    calls.length = 0;
    let modelTurns = 0;
    const { runAgentOnce } = await import('../lib/agent-runtime');
    const runtimeAgent: Agent = { ...agent, id: 'reddit-runtime-agent', integrationOverrides: redditCreds('runtime-read') };
    const completed = await runAgentOnce(runtimeAgent, 'Read the installed Reddit community and report the result.', {
      grokChatFn: async (params) => {
        modelTurns++;
        if (modelTurns === 1) {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'reddit-read-trace-check',
                  type: 'function',
                  function: { name: 'reddit_read_posts', arguments: JSON.stringify({ limit: 1 }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          };
        }
        const transient = [...params.messages].reverse().find((message) => message.role === 'tool');
        assert(String(transient?.content || '').includes('A useful type-system idea'), 'active model turn receives Reddit content');
        return { choices: [{ message: { role: 'assistant', content: 'Read one Reddit post.' }, finish_reason: 'stop' }] };
      },
    });
    const durableRead = JSON.stringify(completed.trace.find((step) => step.type === 'result' && step.tool?.name === 'reddit_read_posts'));
    assert(durableRead.includes('"postsRead":1') && durableRead.includes('"contentRetained":false'), 'durable trace records only bounded Reddit read metadata');
    assert(!durableRead.includes('A useful type-system idea') && !durableRead.includes('verify_author'), 'durable trace omits Reddit content and author');

    scenario = 'normal';
    calls.length = 0;
    let submitTurns = 0;
    const postAgent: Agent = { ...agent, id: 'reddit-runtime-post-agent', integrationOverrides: redditCreds('runtime-post') };
    const postedRun = await runAgentOnce(postAgent, 'Publish a text post to Reddit in r/testing with the supplied title and body.', {
      grokChatFn: async () => {
        submitTurns++;
        if (submitTurns === 1) {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'reddit-runtime-submit',
                  type: 'function',
                  function: {
                    name: 'reddit_submit',
                    arguments: JSON.stringify({ subreddit: 'testing', title: 'Interesting', text: 'Confirmed once.' }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          };
        }
        throw new Error('Grok API error 403: unauthenticated:bad-credentials');
      },
    });
    const runtimeSubmitCalls = calls.filter((call) => new URL(call.url).pathname === '/external/shiba/posts/submit');
    assert(runtimeSubmitCalls.length === 1, 'confirmed runtime post is never replayed after a later model failure');
    assert(postedRun.status === 'completed', 'confirmed Reddit post survives a later Grok auth failure');
    assert(postedRun.finalOutput?.includes('Posted to Reddit:') && postedRun.finalOutput.includes('No duplicate post was attempted'), 'post-commit fallback reports success instead of a false failed run');
    assert(!postedRun.trace.some((step) => step.type === 'error'), 'confirmed Reddit post leaves no fatal error trace');
  } finally {
    globalThis.fetch = originalFetch;
    const { setPersistenceDataDir } = await import('../lib/persistence');
    setPersistenceDataDir(null);
  }
}

async function main(): Promise<void> {
  await fs.mkdir(SCRATCH, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-reddit-devvit-verify-'));
  log(`REDDIT_DEVVIT_VERIFY ${new Date().toISOString()}`);
  try {
    await verifyStructuralWiring();
    await verifyTransportAndRuntime(tempDir);
    log(`PASS: Reddit Devvit regression harness (${passed} checks)`);
    await fs.writeFile(LOG, `${lines.join('\n')}\n`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main()
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    log(`FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    await fs.mkdir(SCRATCH, { recursive: true }).catch(() => undefined);
    await fs.writeFile(LOG, `${lines.join('\n')}\n`).catch(() => undefined);
    process.exit(1);
  });
