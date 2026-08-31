/**
 * Drive the shipped Responses request builder and citation/tool-trace parser.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import { buildGrokChatStreamRequest } from '../lib/grok-chat-stream';
import { mapXaiResponsesEvent, XAI_BUILTIN_SERVER_TOOLS } from '../lib/xai-responses';

const LOG = path.join(SCRATCH, 'verify-xai-builtin-tools.log');
const lines: string[] = [];

function log(msg: string) {
  lines.push(msg);
  console.log(msg);
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  log(`XAI_BUILTIN_TOOLS_VERIFY ${new Date().toISOString()}`);

  const built = buildGrokChatStreamRequest({
    model: 'cloud:grok-4.6',
    messages: [{ role: 'user', content: 'What did xAI ship this week?' }],
  });
  assert.equal(built.useResponses, true);
  assert.match(built.url, /\/responses$/);
  const tools = built.body.tools as Array<{ type?: string }>;
  const types = new Set((tools || []).map((t) => t.type));
  assert.ok(types.has('x_search'), 'request includes x_search');
  assert.ok(types.has('web_search'), 'request includes web_search');
  assert.ok(types.has('code_interpreter'), 'request includes code_interpreter');
  for (const expected of XAI_BUILTIN_SERVER_TOOLS) {
    assert.ok(types.has(expected.type), `builtin ${expected.type}`);
  }
  log('OK Responses body includes x_search, web_search, code_interpreter');

  const local = buildGrokChatStreamRequest({
    model: 'local:llama',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(local.useResponses, false);
  assert.match(local.url, /\/chat\/completions$/);
  log('OK local models stay on chat completions');

  const events = [...mapXaiResponsesEvent({
    type: 'response.output_item.done',
    item: {
      type: 'x_search_call',
      query: 'xAI grok 4.6',
      citations: [{ url: 'https://x.ai/news/grok-4-6', title: 'Grok 4.6' }],
    },
  })];
  const traces = events.filter((e) => e.type === 'tool-trace');
  const citations = events.filter((e) => e.type === 'citation');
  const thinking = events.filter((e) => e.type === 'thinking');
  assert.ok(traces.some((e) => e.type === 'tool-trace' && e.name === 'x_search'));
  assert.ok(citations.some((e) => e.type === 'citation' && e.url === 'https://x.ai/news/grok-4-6'));
  assert.ok(thinking.some((e) => e.type === 'thinking' && /xAI X search/i.test(e.delta)));
  log('OK parser surfaces x_search tool trace and citation URL');

  await fs.writeFile(LOG, lines.join('\n') + '\n');
  console.log('PASS: xAI built-in Responses tools');
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  console.error(`FAIL: ${msg}`);
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(LOG, `${lines.join('\n')}\nFAIL: ${msg}\n`).catch(() => {});
  process.exit(1);
});
