import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-context-engine-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '55'.repeat(32);

  const dbModule = await import('../lib/db');
  const context = await import('../lib/context-engine');
  const chats = await import('../lib/chat-sessions');

  try {
    context.ensureContextSchema();
    const db = dbModule.getDb();
    for (const table of ['context_sources', 'context_compactions', 'context_scope_state']) {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert(found, `${table} should exist without a schema-version migration`);
    }

    const now = new Date().toISOString();
    const messages = Array.from({ length: 112 }, (_, index) => ({
      id: `message-${index}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: index === 2
        ? 'Non-negotiable: the launch color must remain violet-orbit. Never replace it with orange.'
        : index === 7
          ? 'Unresolved question: does the release require legal approval? Keep this pending until the user confirms.'
          : index === 95
            ? 'The integration report records citation-target-95 and the final validation result.'
            : `Turn ${index}: durable discussion detail ${index}.`,
      createdAt: now,
    }));

    context.indexSessionMessages('session-long', messages, 'project-a');
    const prepared = context.prepareSessionContext({
      sessionId: 'session-long',
      projectId: 'project-a',
      messages,
      model: 'cloud:test-context',
    });
    assert(prepared.replayMessages.length <= 36, 'model replay should be bounded below the old fixed 60-message replay');
    assert(prepared.replayMessages.length > 0);
    assert(prepared.meter.compactedSourceCount >= 76, 'older sources should be compacted rather than silently omitted');
    assert(prepared.systemContext.includes('violet-orbit'), 'early non-negotiable constraints should survive compaction');
    assert(prepared.systemContext.includes('legal approval'), 'unresolved questions should survive compaction');
    assert(prepared.systemContext.includes('source:ctx:session:session-long:message:message-2'));
    assert.equal(prepared.meter.sourceCount, 112);
    assert.equal(prepared.meter.replayCount, prepared.replayMessages.length);
    assert.equal(prepared.meter.model, 'cloud:test-context');
    assert(prepared.meter.breakdown.messageTokens > 0);

    const firstInspection = context.inspectContextScope('session', 'session-long');
    assert.equal(firstInspection.sources.length, 112);
    assert(firstInspection.compactions.length >= 4);
    const deterministic = firstInspection.compactions.map(({ id, sourceDigest, summary, sourceIds }) => ({ id, sourceDigest, summary, sourceIds }));
    context.compactContextScope('session', 'session-long');
    const secondInspection = context.inspectContextScope('session', 'session-long');
    assert.deepEqual(
      secondInspection.compactions.map(({ id, sourceDigest, summary, sourceIds }) => ({ id, sourceDigest, summary, sourceIds })),
      deterministic,
      'same sources should produce byte-identical durable compactions and ids',
    );
    const page = context.inspectContextScope('session', 'session-long', { sourceLimit: 10, sourceOffset: 5 });
    assert.equal(page.sources.length, 10);
    assert.equal(page.pagination.totalSources, 112);
    assert.equal(page.pagination.truncated, true);

    const early = firstInspection.sources.find((source) => source.sourceKey === 'message-2');
    assert(early);
    context.setContextSourcePinned(early.sourceId, true, { scopeType: 'session', scopeId: 'session-long' });
    const withPin = context.prepareSessionContext({ sessionId: 'session-long', projectId: 'project-a', messages });
    assert(withPin.meter.pinnedTokens > 0);
    assert(withPin.systemContext.includes('## Pinned session context'));

    const pinMessages = Array.from({ length: 8 }, (_, index) => ({
      id: `pin-${index}`,
      role: 'user' as const,
      content: `Pinned ${index}: ${'bounded pinned detail '.repeat(400)}`,
      createdAt: now,
    }));
    context.indexSessionMessages('session-pins', pinMessages);
    for (const source of context.inspectContextScope('session', 'session-pins').sources) {
      context.setContextSourcePinned(source.sourceId, true, { scopeType: 'session', scopeId: 'session-pins' });
    }
    const boundedPins = context.prepareSessionContext({ sessionId: 'session-pins', messages: pinMessages, maxReplayTokens: 2_000 });
    assert.equal(boundedPins.meter.maxPinnedTokens, 512);
    assert(boundedPins.meter.pinnedTokens <= 512, 'pinned content must obey its own model-context budget');
    assert((boundedPins.meter.pinnedOverflowCount || 0) > 0, 'overflow pins remain available by citation');
    assert.match(boundedPins.systemContext, /citation-only/);

    const search = context.searchContext({
      query: 'citation-target-95 validation',
      scopeType: 'session',
      scopeId: 'session-long',
      maxResults: 2,
      maxChars: 1_200,
    });
    assert.equal(search.matches[0]?.citation.sourceId, 'ctx:session:session-long:message:message-95');
    assert(search.matches[0]?.before?.sourceId, 'search results should have a bounded previous-message bookend');
    assert(search.matches[0]?.after?.sourceId, 'search results should have a bounded next-message bookend');
    assert(search.limits.returnedChars <= 1_200);
    assert(search.matches.length <= 2);
    const exactSource = context.getContextSource(search.matches[0].citation.sourceId);
    assert(exactSource.source.content.includes('citation-target-95'));
    assert(exactSource.before && exactSource.after);

    context.indexProjectContext({
      id: 'project-a',
      name: 'Violet launch',
      description: 'Project nebula-marker context',
      instructions: 'Preserve the approved palette.',
      workspacePath: root,
      defaultAgentId: '',
      files: [{
        id: 'file-1',
        name: 'launch.md',
        storedName: 'launch.md',
        size: 120,
        uploadedAt: now,
        checksum: 'abc123',
        mimeType: 'text/markdown',
      }],
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    const projectSearch = context.searchContext({ query: 'nebula-marker', projectId: 'project-a' });
    assert(projectSearch.matches.some((match) => match.citation.scopeType === 'project'));

    context.indexRunContext({
      id: 'run-1',
      agentId: 'agent-1',
      agentName: 'Verifier',
      prompt: 'Investigate run-prompt-marker for the launch.',
      model: 'cloud:test',
      startedAt: now,
      completedAt: now,
      status: 'completed',
      trace: [{ id: 'trace-1', ts: now, type: 'result', content: 'run-trace-marker passed' }],
      finalOutput: 'The run-output-marker is complete.',
      sideEffects: [],
      projectId: 'project-a',
    });
    const runSearch = context.searchContext({ query: 'run-output-marker', projectId: 'project-a' });
    assert.equal(runSearch.matches[0]?.citation.runId, 'run-1');

    db.prepare(`
      INSERT INTO runs
        (id, agentId, agentName, model, status, prompt, startedAt, completedAt,
         finalOutput, sideEffects, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-run', 'agent-legacy', 'Legacy', 'cloud:test', 'completed',
      'legacy-backfill-prompt', now, now, 'legacy-backfill-output', '[]', '[]',
    );
    const backfilled = await context.backfillContextIndexes({ maxRuns: 50 });
    assert(backfilled.runs >= 1);
    assert.equal(context.searchContext({ query: 'legacy-backfill-output', runId: 'legacy-run' }).matches.length, 1);

    const chat = await chats.createChatSession({ title: 'Hook verification' });
    await chats.updateChatSession(chat.id, {
      messages: [{ id: 'hook-message', role: 'user', content: 'chat-hook-marker', createdAt: now }],
    });
    assert.equal(context.inspectContextScope('session', chat.id).sources.length, 1, 'chat writes should index automatically');
    assert.throws(
      () => context.setContextSourcePinned(early.sourceId, true, { scopeType: 'session', scopeId: 'some-other-session' }),
      /does not belong/,
    );
    await chats.deleteChatSession(chat.id);
    assert.equal(context.inspectContextScope('session', chat.id).sources.length, 0, 'chat deletion should clear its context scope');

    console.log('CONTEXT_ENGINE_OK sources=112 replay<=36 citations=stable compaction=deterministic search=bounded indexes=session+project+run');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
