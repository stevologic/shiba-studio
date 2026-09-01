/**
 * One durable thread per Grok / agent / All-agents target, plus throwaway
 * ephemeral chats. Exercises the real store, API, and rail grouping.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { ChatSession } from '../lib/chat-session-types';

const ROOT = path.resolve(__dirname, '..');

async function postChatSessions(action: string, body: Record<string, unknown>) {
  const { POST } = await import('../app/api/chat-sessions/route');
  return POST(new NextRequest('http://localhost/api/chat-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  }));
}

function sampleSession(partial: Partial<ChatSession> & Pick<ChatSession, 'id' | 'chatTarget'>): ChatSession {
  const now = partial.updatedAt || '2026-09-01T00:00:00.000Z';
  return {
    title: partial.title || 'New chat',
    chatModel: 'cloud:test',
    projectId: null,
    useGrokCli: false,
    reasoningEffort: 'low',
    messages: [],
    createdAt: now,
    updatedAt: now,
    unreadCount: 0,
    ...partial,
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-chat-canonical-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '77'.repeat(32);

  const dbModule = await import('../lib/db');
  const chats = await import('../lib/chat-sessions');
  const types = await import('../lib/chat-session-types');

  try {
    const first = await chats.openCanonicalChatSession({ chatTarget: 'grok' });
    assert.equal(first.created, true, 'first Grok open creates the durable thread');
    assert.equal(first.session.chatTarget, 'grok');
    assert.equal(first.session.title, 'Grok');
    assert.equal(first.session.ephemeral, false);
    assert.equal(first.session.branch, undefined);

    const again = await chats.openCanonicalChatSession({ chatTarget: 'grok' });
    assert.equal(again.created, false, 'second Grok open reuses the same thread');
    assert.equal(again.session.id, first.session.id);

    const agent = await chats.openCanonicalChatSession({
      chatTarget: 'agent-orchestration',
      title: 'Orchestration Agent',
    });
    assert.equal(agent.created, true);
    assert.equal(agent.session.title, 'Orchestration Agent');
    assert.notEqual(agent.session.id, first.session.id, 'agent 1:1 is a different thread from Grok');

    const group = await chats.openCanonicalChatSession({ chatTarget: 'all' });
    assert.equal(group.created, true);
    assert.equal(group.session.title, 'All agents');
    assert.notEqual(group.session.id, first.session.id);
    assert.notEqual(group.session.id, agent.session.id);

    const extraGrok = await chats.createChatSession({ title: 'Legacy Grok chat', chatTarget: 'grok' });
    const reusedGrok = await chats.openCanonicalChatSession({ chatTarget: 'grok' });
    assert.equal(
      reusedGrok.session.id,
      extraGrok.id,
      'openCanonical reuses the newest standalone thread for that target',
    );

    const bot = await chats.createChatSession({
      id: 'grok-bot',
      title: 'Grok Bot',
      chatTarget: 'grok',
    });
    const grokAfterBot = await chats.openCanonicalChatSession({ chatTarget: 'grok' });
    assert.notEqual(grokAfterBot.session.id, bot.id, 'Grok Bot log is not the Grok 1:1 thread');

    await chats.archiveChatSession(extraGrok.id, true);
    await chats.archiveChatSession(first.session.id, true);
    const restoredGrok = await chats.openCanonicalChatSession({ chatTarget: 'grok' });
    assert.ok(
      restoredGrok.session.id === extraGrok.id || restoredGrok.session.id === first.session.id,
      'opening Grok restores an archived 1:1 thread rather than creating a third',
    );
    assert.notEqual(restoredGrok.session.id, bot.id);
    assert.equal(restoredGrok.session.archived, false);

    await chats.archiveChatSession(agent.session.id, true);
    const restoredAgent = await chats.openCanonicalChatSession({
      chatTarget: 'agent-orchestration',
      title: 'Orchestration Agent',
    });
    assert.equal(restoredAgent.session.id, agent.session.id);
    assert.equal(restoredAgent.session.archived, false);
    assert.equal(restoredAgent.session.title, 'Orchestration Agent');

    const untitled = await chats.createChatSession({ title: 'New chat', chatTarget: 'solo-agent' });
    const named = await chats.openCanonicalChatSession({
      chatTarget: 'solo-agent',
      title: 'Solo Agent',
    });
    assert.equal(named.session.id, untitled.id);
    assert.equal(named.session.title, 'Solo Agent', 'generic New chat titles upgrade to the persona name');

    const ephemeralA = await chats.createChatSession({ title: 'Incognito A', ephemeral: true });
    const ephemeralB = await chats.createChatSession({ title: 'Incognito B', ephemeral: true });
    assert.notEqual(ephemeralA.id, ephemeralB.id, 'each ephemeral chat is a new session');
    assert.equal(ephemeralA.ephemeral, true);
    assert.equal(ephemeralB.ephemeral, true);

    const apiFirst = await postChatSessions('openCanonical', { chatTarget: 'api-agent', title: 'API Agent' });
    const apiFirstBody = await apiFirst.json();
    assert.equal(apiFirstBody.ok, true);
    assert.equal(apiFirstBody.created, true);
    assert.equal(apiFirstBody.session.title, 'API Agent');
    const apiAgain = await postChatSessions('openCanonical', { chatTarget: 'api-agent' });
    const apiAgainBody = await apiAgain.json();
    assert.equal(apiAgainBody.created, false);
    assert.equal(apiAgainBody.session.id, apiFirstBody.session.id);

    const apiEphemeral = await postChatSessions('create', { defaults: { ephemeral: true } });
    const apiEphemeralBody = await apiEphemeral.json();
    assert.equal(apiEphemeralBody.ok, true);
    assert.equal(apiEphemeralBody.session.ephemeral, true);

    const autotitle = await postChatSessions('autotitle', { id: apiFirstBody.session.id });
    const autotitleBody = await autotitle.json();
    assert.equal(autotitleBody.skipped, 'canonical thread', 'durable 1:1 threads keep their persona title');

    const archivedAgent = sampleSession({
      id: 'archived-agent',
      chatTarget: 'agent-old',
      title: 'Old Agent',
      archived: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const liveGrok = sampleSession({
      id: 'live-grok',
      chatTarget: 'grok',
      title: 'Grok',
      unreadCount: 2,
      updatedAt: '2026-09-01T12:00:00.000Z',
    });
    const extraLiveGrok = sampleSession({
      id: 'legacy-grok',
      chatTarget: 'grok',
      title: 'Older Grok',
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    const liveAgent = sampleSession({
      id: 'live-agent',
      chatTarget: 'agent-1',
      title: 'Research',
      unreadCount: 1,
      updatedAt: '2026-09-01T11:00:00.000Z',
    });
    const liveGroup = sampleSession({
      id: 'live-group',
      chatTarget: 'all',
      title: 'All agents',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
    const ephemeral = sampleSession({
      id: 'eph-1',
      chatTarget: 'grok',
      title: 'Scratch',
      ephemeral: true,
      updatedAt: '2026-09-01T09:00:00.000Z',
    });
    const reserved = sampleSession({
      id: 'grok-bot',
      chatTarget: 'grok',
      title: 'Grok Bot',
      updatedAt: '2026-09-01T13:00:00.000Z',
    });
    const forked = sampleSession({
      id: 'fork-1',
      chatTarget: 'grok',
      title: 'Fork',
      branch: {
        kind: 'checkpoint-branch-v1',
        parentSessionId: 'live-grok',
        rootSessionId: 'live-grok',
        sourceMessageId: 'm1',
        sourceMessageOrdinal: 0,
        depth: 1,
        createdAt: '2026-09-01T08:00:00.000Z',
      },
      updatedAt: '2026-09-01T08:00:00.000Z',
    });

    const rail = types.groupChatSessionsForRail([
      archivedAgent,
      liveGrok,
      extraLiveGrok,
      liveAgent,
      liveGroup,
      ephemeral,
      reserved,
      forked,
    ]);
    const byId = Object.fromEntries(rail.map((section) => [section.id, section]));
    assert.deepEqual(byId.grok?.sessions.map((session) => session.id), ['live-grok']);
    assert.equal(byId.grok?.unreadCount, 2);
    assert.deepEqual(byId.agents?.sessions.map((session) => session.id), ['live-agent']);
    assert.equal(byId.agents?.unreadCount, 1);
    assert.deepEqual(byId.group?.sessions.map((session) => session.id), ['live-group']);
    assert.deepEqual(byId.ephemeral?.sessions.map((session) => session.id), ['eph-1']);
    assert.deepEqual(byId.forks?.sessions.map((session) => session.id), ['fork-1']);
    assert.deepEqual(byId.archived?.sessions.map((session) => session.id), ['archived-agent']);
    assert.ok(byId.other?.sessions.some((session) => session.id === 'legacy-grok'), 'duplicate live threads land in Other');
    assert.ok(byId.other?.sessions.some((session) => session.id === 'grok-bot'), 'Grok Bot log is not the Grok room');
    assert.equal(types.isCanonicalChatThread(reserved), false);
    assert.equal(types.isCanonicalChatThread(liveGrok), true);
    assert.equal(types.isCanonicalChatThread(ephemeral), false);
    assert.equal(types.canonicalTitleForTarget('all'), 'All agents');
    assert.equal(types.canonicalTitleForTarget('agent-1', 'Research'), 'Research');

    const panel = await fs.readFile(path.join(ROOT, 'components/chat-sessions-panel.tsx'), 'utf8');
    assert(panel.includes("action: 'openCanonical'"), 'chat rail opens canonical threads');
    assert(panel.includes('onOpenTarget={(target) => void openCanonical(target)}'), 'target picker navigates durable rooms');
    assert(panel.includes('ephemeral: true'), 'ephemeral chats still create a new session');
    assert(panel.includes('groupChatSessionsForRail'), 'rail uses target grouping');

    const chatPanel = await fs.readFile(path.join(ROOT, 'components/grok-chat-panel.tsx'), 'utf8');
    assert(chatPanel.includes('onOpenTarget'), 'durable target changes navigate instead of rewriting the thread');
    assert(chatPanel.includes('!session.ephemeral && !session.branch'), 'ephemeral chats still retarget in place');

    const studio = await fs.readFile(path.join(ROOT, 'components/shiba-studio.tsx'), 'utf8');
    assert(studio.includes("action: 'openCanonical'"), 'top bar / Ctrl+N opens the Grok thread');
    assert(studio.includes("defaults: { ephemeral: true }"), 'top bar eye-off still creates ephemeral chats');
    assert(studio.includes('aria-label="Open Grok chat"'), 'top bar names the Grok thread');

    console.log('CHAT_CANONICAL_OK one-thread-per-target ephemeral=fresh reserved=excluded archived=visible');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
