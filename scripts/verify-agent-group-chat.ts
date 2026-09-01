import './verify-isolate';
import assert from 'node:assert/strict';
import {
  enqueueMentionedAgents,
  findMentionedAgents,
  formatGroupChatHistory,
  initialRoomQueue,
  peerDirectoryLine,
  resolveAgentRef,
} from '../lib/agent-group-chat';
import { buildAgentChatSystem } from '../lib/chat-skill';
import { normalizeAgent } from '../lib/types';

const now = new Date().toISOString();

function agent(id: string, name: string) {
  return normalizeAgent({
    id,
    name,
    model: 'cloud:test',
    workspace: { path: process.cwd(), useWorktree: false },
    integrations: {},
    peers: [],
    createdAt: now,
    updatedAt: now,
  });
}

async function main() {
  const alice = agent('alice-id', 'Alice');
  const bob = agent('bob-id', 'Research Agent');
  const cara = agent('cara-id', 'Cara');
  const roster = [alice, bob, cara];

  assert.deepEqual(
    findMentionedAgents('Hey @Alice, can you help?', roster).map((item) => item.id),
    ['alice-id'],
    '@Name picks an agent',
  );
  assert.deepEqual(
    findMentionedAgents('Ping @Research Agent and @cara-id.', roster).map((item) => item.id),
    ['bob-id', 'cara-id'],
    'longer names win over prefixes; ids work',
  );
  assert.deepEqual(
    findMentionedAgents('@alice-id stop', roster).map((item) => item.id),
    ['alice-id'],
    '@id mention',
  );
  assert.equal(findMentionedAgents('email alice@example.com', roster).length, 0, 'email is not a mention');
  assert.equal(
    findMentionedAgents('@Alice please', roster, 'alice-id').length,
    0,
    'exceptId skips the current speaker',
  );

  assert.equal(resolveAgentRef('Alice', roster)?.id, 'alice-id');
  assert.equal(resolveAgentRef('@research agent', roster)?.id, 'bob-id');
  assert.equal(resolveAgentRef('missing', roster), null);

  assert.deepEqual(
    initialRoomQueue('What do you think @Cara?', roster).map((item) => item.name),
    ['Cara'],
    'user @mention opens the room with that agent',
  );
  assert.deepEqual(
    initialRoomQueue('Talk amongst yourselves', roster).map((item) => item.id),
    ['alice-id', 'bob-id', 'cara-id'],
    'no mention → full roster',
  );

  const spoken = new Map<string, number>([['alice-id', 1]]);
  const queued = enqueueMentionedAgents({
    text: '@Research Agent I need a second opinion. @Alice already spoke.',
    agents: roster,
    currentId: 'alice-id',
    queue: [],
    spokenCounts: spoken,
  });
  assert.deepEqual(queued.map((item) => item.id), ['bob-id'], 'newly mentioned peer joins; speaker is skipped');

  const formatted = formatGroupChatHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi from Alice', agentId: 'alice-id', agentName: 'Alice' },
  ]);
  assert.equal(formatted[1]?.content, 'Alice: hi from Alice');

  const system = buildAgentChatSystem(alice, [{ id: 'bob-id', name: 'Research Agent' }]);
  assert.match(system, /@Research Agent/);
  assert.match(system, /talk_to_agent/);

  const directory = peerDirectoryLine(roster, 'alice-id');
  assert.match(directory, /@Cara \(id:cara-id\)/);
  assert.doesNotMatch(directory, /@Alice \(id:alice-id\)/);

  await import('../lib/chat-types').then((mod) => {
    const event = { type: 'agent-turn-start' as const, agentId: 'alice-id', name: 'Alice', messageId: 'm1' };
    const _ok: typeof event = event;
    void _ok;
    void mod;
  });

  console.log('PASS: agent group chat mentions, room queue, and prompts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
