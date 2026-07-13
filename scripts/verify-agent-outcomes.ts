import './verify-isolate'; // MUST be first: never touch the live Studio data store.

import assert from 'node:assert/strict';
import type { Agent } from '../lib/types';
import { runAgentOnce, type AgentRunOpts } from '../lib/agent-runtime';
import { getRun } from '../lib/agent-runs-store';
import { getTask } from '../lib/task-ledger';
import { saveConfig } from '../lib/persistence';
import { saveOAuthSession } from '../lib/xai-oauth';

const BAD_CREDENTIALS = 'Grok API error 403: {"code":"unauthenticated:bad-credentials","error":"The OAuth2 access token could not be validated."}';
const OLD_TOKEN = 'oauth-before-approval';
const NEW_TOKEN = 'oauth-after-approval';
const TWEET_ID = 'tweet-123';
const TWEET_URL = `https://x.com/i/web/status/${TWEET_ID}`;

function oauthSession(accessToken: string) {
  return {
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    connectedAt: new Date().toISOString(),
    oidcClientId: 'client',
  };
}

function testAgent(): Agent {
  return {
    id: 'verify-agent-x-outcome',
    name: 'X outcome verifier',
    model: 'cloud:grok-test',
    workspace: { path: process.cwd(), useWorktree: false },
    integrations: {
      github: false,
      slack: false,
      googledrive: false,
      discord: false,
      x: true,
      obsidian: false,
      vercel: false,
      netlify: false,
    },
    integrationOverrides: {
      x: {
        apiKey: 'x-api-key',
        apiSecret: 'x-api-secret',
        accessToken: 'x-access-token',
        accessTokenSecret: 'x-access-secret',
      },
    },
    peers: [],
    skills: [],
    schedules: [],
    learning: { mode: 'off', autoRecall: false, maxMemories: 20 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  await saveConfig({ xaiApiKey: '', cloudAuthMode: 'oauth', integrations: {} });
  await saveOAuthSession(oauthSession(OLD_TOKEN));

  let modelCalls = 0;
  let xPostCalls = 0;
  const mockGrokChat: NonNullable<AgentRunOpts['grokChatFn']> = async (params) => {
    modelCalls++;
    if (modelCalls === 1) {
      assert.equal(params.cloudKey, OLD_TOKEN, 'first model turn uses the initial OAuth bearer');
      assert.equal(params.cloudAuthSource, 'oauth', 'model turn preserves OAuth credential identity');
      // Reproduce a token rotation while the run is paused between model turns.
      await saveOAuthSession(oauthSession(NEW_TOKEN));
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'post-call-1',
              type: 'function',
              function: { name: 'x_post', arguments: JSON.stringify({ text: 'A short test post.' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    }
    assert.equal(params.cloudKey, NEW_TOKEN, 'follow-up model turn reloads a rotated OAuth bearer');
    assert.equal(params.cloudAuthSource, 'oauth', 'follow-up model turn remains OAuth-scoped');
    throw new Error(BAD_CREDENTIALS);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url === 'https://api.twitter.com/2/tweets' && method === 'POST') {
      xPostCalls++;
      return new Response(JSON.stringify({ data: { id: TWEET_ID } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected network request in agent outcome verification: ${method} ${url}`);
  }) as typeof fetch;

  let completedRun;
  try {
    completedRun = await runAgentOnce(testAgent(), 'Post one short thought to X.', { grokChatFn: mockGrokChat });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(modelCalls, 2, 'the model was called once before and once after the post');
  assert.equal(xPostCalls, 1, 'the X mutation ran exactly once');
  assert.equal(completedRun.status, 'completed', 'a confirmed X receipt is not overwritten by a later auth error');
  assert.match(completedRun.finalOutput || '', /Posted to X:/, 'deterministic final output reports the completed post');
  assert.match(completedRun.finalOutput || '', new RegExp(TWEET_ID), 'deterministic final output includes the X receipt URL');
  assert.match(completedRun.finalOutput || '', /No duplicate post was attempted/i, 'deterministic final output explains duplicate protection');
  assert(!completedRun.trace.some((step) => step.type === 'error'), 'post-summary auth failure is recorded as non-fatal');
  const receipt = completedRun.trace.find((step) => step.type === 'result' && step.tool?.name === 'x_post')?.tool?.result as { ok?: boolean; url?: string } | undefined;
  assert.equal(receipt?.ok, true, 'trace retains the authoritative successful X receipt');
  assert.equal(receipt?.url, TWEET_URL, 'trace retains the posted status URL');

  const persisted = await getRun(completedRun.id);
  assert.equal(persisted?.status, 'completed', 'persisted run remains completed');
  assert.match(persisted?.finalOutput || '', new RegExp(TWEET_ID), 'persisted result includes the post URL');
  const completedTask = getTask(completedRun.taskId!);
  assert.equal(completedTask?.status, 'succeeded', 'task ledger projects the confirmed post as succeeded');
  assert.equal(completedTask?.error ?? null, null, 'succeeded post has no task error');

  const failedRun = await runAgentOnce(testAgent(), 'Fail before posting.', {
    grokChatFn: async () => { throw new Error(BAD_CREDENTIALS); },
  });
  assert.equal(failedRun.status, 'error', 'an auth failure without a successful X receipt remains fatal');
  assert(failedRun.trace.some((step) => step.type === 'error'), 'uncommitted auth failure retains an error trace');
  assert.equal(getTask(failedRun.taskId!)?.status, 'failed', 'uncommitted auth failure remains failed in the ledger');

  console.log('Agent outcome verification passed: 18 assertions, 0 failed');
}

main().catch((error) => {
  console.error('Agent outcome verification failed', error);
  process.exit(1);
});
