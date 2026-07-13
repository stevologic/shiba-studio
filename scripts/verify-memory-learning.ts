import './verify-isolate'; // MUST be first: sandbox the data dir on direct runs
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

let passed = 0;
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  passed += 1;
  console.log(`  OK ${label}`);
}

async function main() {
  const testData = path.join(GOAL_SCRATCH, `memory-learning-${Date.now()}`);
  process.env.SHIBA_DATA_DIR = testData;
  await fs.mkdir(testData, { recursive: true });

  const memory = await import('../lib/agent-memory');
  const { getDb, closeDb } = await import('../lib/db');
  const { normalizeAgent } = await import('../lib/types');
  const { learnFromCompletedRun } = await import('../lib/agent-learning');
  const { parseSlashCommand, slashCommandMatches, renderChatCommandHelp } = await import('../lib/chat-commands');
  const { toolNeedsApproval } = await import('../lib/tool-approval');
  const { NextRequest } = await import('next/server');
  const { POST: chatToolsPost } = await import('../app/api/chat-tools/route');
  const { POST: agentsPost } = await import('../app/api/agents/route');

  console.log('=== MEMORY + LEARNING VERIFICATION ===');

  const columns = (getDb().prepare('PRAGMA table_info(agent_memory)').all() as Array<{ name: string }>).map((row) => row.name);
  for (const name of ['kind', 'status', 'source', 'sourceId', 'confidence', 'pinned', 'createdAt', 'lastUsedAt', 'useCount']) {
    assert(columns.includes(name), `versioned memory schema includes ${name}`);
  }

  const manual = memory.saveMemory('agent-a', 'deploy-command', 'Use npm run deploy:prod', {
    source: 'manual', kind: 'procedure', pinned: true,
  }).entry;
  assert(manual.pinned && manual.source === 'manual', 'manual pinned memory saves with metadata');
  const protectedWrite = memory.saveMemory('agent-a', 'deploy-command', 'Overwrite attempt', {
    source: 'learned', sourceId: 'run-overwrite', protectManual: true,
  });
  assert(protectedWrite.skipped && protectedWrite.entry.content === 'Use npm run deploy:prod', 'automatic learning never overwrites manual or pinned memory');

  memory.saveMemory(memory.CHAT_MEMORY_SCOPE, 'timezone', 'User works in America/Phoenix', { source: 'manual', kind: 'preference' });
  assert(memory.listMemories({ agentId: 'agent-a' }).total === 1, 'agent scope stays isolated from shared chat memory');
  assert(memory.listMemories({ query: 'Phoenix' }).entries.length === 1, 'memory search filters in SQL across all rows');
  const invalidScopeResponse = await chatToolsPost(new NextRequest('http://localhost/api/chat-tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'recall', agentId: 'deleted-agent' }),
  }));
  assert(invalidScopeResponse.status === 400, 'invalid agent scope never falls back to shared chat memory');
  const sharedBeforeDelete = memory.listMemories({ agentId: memory.CHAT_MEMORY_SCOPE }).total;
  const invalidDeleteResponse = await agentsPost(new NextRequest('http://localhost/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: memory.CHAT_MEMORY_SCOPE }),
  }));
  assert(
    invalidDeleteResponse.status === 404 && memory.listMemories({ agentId: memory.CHAT_MEMORY_SCOPE }).total === sharedBeforeDelete,
    'deleting an unknown agent cannot purge shared memories',
  );

  const relevant = memory.recallRelevantMemories('agent-a', 'Please deploy this project to production', 8);
  assert(relevant.some((entry) => entry.key === 'deploy-command'), 'relevance recall injects matching and pinned memory');
  assert((memory.getMemory(manual.id)?.useCount || 0) > 0, 'recall usage is tracked');
  const sensitiveManual = memory.saveMemory('agent-a', 'production-token', 'access_token: ghp_1234567890abcdefghijkl', {
    source: 'manual', pinned: true,
  }).entry;
  assert(
    !memory.recallRelevantMemories('agent-a', 'Use the production token', 8).some((entry) => entry.id === sensitiveManual.id),
    'credential-like manual notes are never injected automatically',
  );
  assert(
    memory.looksSensitive('database-password\nhunter2') && memory.looksSensitive('auth-header\nBearer abcdefghijklmnopqrstuvwxyz'),
    'secret screen catches credential-like keys and bearer tokens',
  );
  const explicitSensitiveRecall = memory.recallMemories('agent-a', 'production-token');
  assert(
    explicitSensitiveRecall[0]?.key === '[sensitive memory withheld]'
      && !explicitSensitiveRecall[0]?.content.includes('ghp_'),
    'model-visible explicit recall redacts credential-like keys and values',
  );
  assert(
    !memory.looksSensitive('auth-flow\nUse OAuth PKCE for sign-in.')
      && !memory.looksSensitive('token-refresh-strategy\nRefresh before expiry.')
      && !memory.looksSensitive('secret-scanning-policy\nScan every pull request.'),
    'secret screen preserves legitimate auth and security knowledge',
  );
  memory.deleteMemory(sensitiveManual.id);

  const learned = memory.storeLearnedMemories('agent-a', [
    { key: 'testing-rule', content: 'Run npm test before shipping', kind: 'lesson', confidence: 0.92 },
    { key: 'api-secret', content: 'api_key=sk-super-secret-value-123456789', kind: 'fact', confidence: 0.99 },
  ], { sourceId: 'run-1', status: 'pending', maxMemories: 100 });
  assert(learned.length === 1 && learned[0].status === 'pending', 'learned candidates enter review mode');
  assert(!memory.listMemories({ query: 'super-secret' }).entries.length, 'credential-like learned content is rejected');
  const approved = memory.updateMemory(learned[0].id, { status: 'active', pinned: true });
  assert(approved.status === 'active' && approved.pinned, 'pending memory can be approved and pinned');

  const agent = normalizeAgent({
    id: 'agent-b', name: 'Learner', model: 'local:test',
    workspace: { path: '.', useWorktree: false }, integrations: {}, peers: [], schedules: [],
    learning: { mode: 'review', autoRecall: true, maxMemories: 50 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  let learningRequest: { max_tokens: number; usageContext: { source: string; sourceId?: string } } | undefined;
  const extracted = await learnFromCompletedRun(agent, {
    id: 'run-2', prompt: 'Fix and verify the release workflow',
    finalOutput: 'The release workflow requires npm run verify before tagging.',
    sideEffects: ['updated release docs'],
  }, async (params) => {
    learningRequest = { max_tokens: params.max_tokens, usageContext: params.usageContext };
    return { choices: [{ message: { content: JSON.stringify({ memories: [
      { key: 'release-verification', content: 'Run npm run verify before creating a release tag.', kind: 'procedure', confidence: 0.95 },
      { key: 'missing-confidence', content: 'This malformed candidate must not be trusted.', kind: 'fact' },
    ] }) } }] };
  });
  assert(extracted.length === 1 && extracted[0].sourceId === 'run-2' && extracted[0].status === 'pending', 'post-run extractor persists provenance-aware review candidates');
  assert(
    learningRequest?.max_tokens === 384
      && learningRequest.usageContext.source === 'agent'
      && learningRequest.usageContext.sourceId === 'run-2',
    'learning extraction is token-capped and attributed to the originating agent run',
  );
  assert(!memory.listMemories({ query: 'missing-confidence' }).entries.length, 'malformed confidence never becomes automatic memory');

  assert(parseSlashCommand('/searching for docs') === null, 'parser does not hijack unknown command prefixes');
  assert(parseSlashCommand('/commands')?.name === 'help', 'hidden help alias resolves exactly');
  const gitParsed = parseSlashCommand('/git diff --staged');
  assert(gitParsed?.name === 'git' && gitParsed.args === 'diff --staged', 'git family preserves subcommand arguments');
  assert(slashCommandMatches('/git d').some((command) => command.id === 'git-diff'), 'autocomplete resolves nested subcommands');
  assert(slashCommandMatches('/memories')[0]?.id === 'memories', 'exact command prefixes outrank fuzzy description matches');
  assert(toolNeedsApproval('memory_forget', 'ask'), 'memory deletion honors ask-before-act approval');
  const help = renderChatCommandHelp();
  for (const command of ['/task', '/memories', '/forget', '/git pull', '/agent']) assert(help.includes(command), `generated help includes ${command}`);
  const chatPanelSource = await fs.readFile(path.join(process.cwd(), 'components', 'grok-chat-panel.tsx'), 'utf8');
  const modelCommandStart = chatPanelSource.indexOf("if (parsed.name === 'model')");
  const selectedAgentGuard = chatPanelSource.indexOf('if (selectedAgent)', modelCommandStart);
  const modelChange = chatPanelSource.indexOf('onChatModelChange(next.id)', modelCommandStart);
  assert(
    modelCommandStart >= 0
      && selectedAgentGuard > modelCommandStart
      && selectedAgentGuard < modelChange
      && chatPanelSource.includes('owns its model configuration')
      && chatPanelSource.includes('Run `/agent grok` first'),
    '/model blocks before changing state and explains that selected agents keep their configured model',
  );
  const runtimeSource = await fs.readFile(path.join(process.cwd(), 'lib', 'agent-runtime.ts'), 'utf8');
  const learningGuard = runtimeSource.indexOf('estimatedLearningTokens');
  const releaseRunSlot = runtimeSource.lastIndexOf('guards.releaseActiveRun(runId)');
  assert(
    learningGuard >= 0
      && releaseRunSlot > learningGuard
      && runtimeSource.includes('runTokens += learningTokens')
      && runtimeSource.includes('Skipped automatic learning to keep this run within'),
    'automatic learning stays inside concurrency and per-run token guards',
  );

  assert(memory.deleteMemory(approved.id), 'memory delete removes one item');
  const cleared = memory.clearMemories({ agentId: 'agent-b' });
  assert(cleared === 1, 'scope clear removes only selected agent memories');
  assert(memory.listMemories({ agentId: 'agent-a' }).total === 1, 'clearing one scope preserves other agents');

  closeDb();
  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
