import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-live-meetings-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '88'.repeat(32);

  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  const realSource = [
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export const VERSION = 1;',
  ].join('\n');
  await fs.writeFile(path.join(workspace, 'src', 'hello.ts'), realSource, 'utf8');

  const persistence = await import('../lib/persistence');
  const oauth = await import('../lib/xai-oauth');
  const types = await import('../lib/types');
  const liveMeetings = await import('../lib/live-meetings');
  const board = await import('../lib/board');

  try {
    await persistence.saveConfig({ xaiApiKey: 'xai-verifier-key', cloudAuthMode: 'api_key', defaultGrokModel: 'cloud:grok-4' });
    const createdAt = new Date().toISOString();
    await persistence.saveAgents([types.normalizeAgent({
      id: 'agent-reviewer',
      name: 'Review engineer',
      model: 'cloud:grok-4',
      workspace: { path: workspace, useWorktree: false },
      integrations: {},
      peers: [],
      skills: [],
      createdAt,
      updatedAt: createdAt,
    })]);

    liveMeetings.ensureLiveMeetingSchema();

    // Scripted model replies, one per chat-completions call.
    const replies: Array<() => unknown> = [];
    const chatRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let chatCalls = 0;
    let pendingGate: Promise<void> | null = null;
    oauth.setTokenFetcher(async (input, init) => {
      const url = String(input);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xai-verifier-key', 'cloud auth stays server-side');
      assert(url.endsWith('/chat/completions'), `unexpected xAI endpoint ${url}`);
      chatRequests.push(JSON.parse(String(init?.body || '{}')));
      chatCalls++;
      if (pendingGate) {
        const gate = pendingGate;
        pendingGate = null;
        await gate;
      }
      const next = replies.shift();
      assert(next, 'model was called more times than the script expects');
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(next()) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    // 1) Create → agent opens the meeting with a REAL code visual.
    replies.push(() => ({
      say: 'Welcome. Let me walk you through the greeting module we shipped.',
      visual: { kind: 'code', title: 'Greeting entry point', path: 'src/hello.ts', startLine: 1, endLine: 3 },
      suggestions: ['Show me the riskiest code path', 'What is still in flight?'],
    }));
    const meeting = await liveMeetings.createLiveMeeting({ agentId: 'agent-reviewer', title: 'Sprint review', focus: 'launch readiness' });
    assert.equal(meeting.status, 'active');
    assert.equal(meeting.turns.length, 1);
    const opening = meeting.turns[0];
    assert.equal(opening.role, 'agent');
    assert(opening.visual && opening.visual.kind === 'code', 'opening turn carries a code visual');
    assert.equal(opening.visual.path, 'src/hello.ts');
    assert.equal(opening.visual.code, realSource.split('\n').slice(0, 3).join('\n'), 'code excerpt is read from the real workspace file');
    assert.deepEqual(opening.suggestions, ['Show me the riskiest code path', 'What is still in flight?']);

    // 2) Creator turn → diagram visual; edges to unknown nodes are dropped.
    replies.push(() => ({
      say: 'Here is how the pieces fit together.',
      visual: {
        kind: 'diagram',
        title: 'Module map',
        nodes: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API', emphasis: true }],
        edges: [{ from: 'ui', to: 'api', label: 'fetch' }, { from: 'api', to: 'ghost' }],
      },
      suggestions: [],
    }));
    const afterTurn = await liveMeetings.runLiveMeetingTurn(meeting.id, 'Draw me the architecture');
    assert.equal(afterTurn.turns.length, 3);
    assert.equal(afterTurn.turns[1].role, 'creator');
    assert.equal(afterTurn.turns[1].text, 'Draw me the architecture');
    const diagramTurn = afterTurn.turns[2];
    assert(diagramTurn.visual && diagramTurn.visual.kind === 'diagram');
    assert.equal(diagramTurn.visual.nodes.length, 2);
    assert.equal(diagramTurn.visual.edges.length, 1, 'edge to an unknown node is dropped');
    assert(
      chatRequests[1].messages.some((message) => message.role === 'assistant' && message.content.includes('export function greet')),
      'code shown on stage is carried verbatim into the next model call',
    );

    // 3) A hallucinated code path resolves to no visual, never invented code.
    //    The client also reports which visual is on the director's stage.
    replies.push(() => ({
      say: 'Let me show the payment engine.',
      visual: { kind: 'code', title: 'Payments', path: 'src/payments.ts', startLine: 1, endLine: 10 },
      suggestions: [],
    }));
    const afterMissing = await liveMeetings.runLiveMeetingTurn(meeting.id, null, { stageTurnId: opening.id });
    const stageSystem = chatRequests[2].messages[0];
    assert.equal(stageSystem.role, 'system');
    assert(
      stageSystem.content.includes('The director’s stage currently shows: "Greeting entry point"')
        || stageSystem.content.includes('The director\'s stage currently shows: "Greeting entry point"'),
      'the model is told which visual the director is looking at',
    );
    const missingTurn = afterMissing.turns[afterMissing.turns.length - 1];
    assert.equal(missingTurn.role, 'agent');
    assert.equal(missingTurn.visual, undefined, 'nonexistent file yields no code visual');

    // 4) Concurrent turns: the second call fails fast while the first holds the claim.
    replies.push(() => ({ say: 'Thinking slowly about that.', visual: null, suggestions: [] }));
    let unblock!: () => void;
    pendingGate = new Promise<void>((resolve) => { unblock = resolve; });
    const slowTurn = liveMeetings.runLiveMeetingTurn(meeting.id, 'Take your time');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      liveMeetings.runLiveMeetingTurn(meeting.id, 'And also this'),
      /already responding/,
      'a second concurrent turn is refused',
    );
    unblock();
    await slowTurn;

    // 5) End → minutes with a refined display title, direction, decisions, todos.
    replies.push(() => ({
      title: 'Greeting module launch review',
      summary: 'We reviewed the greeting module and the architecture.',
      direction: 'Harden the API layer before launch.',
      decisions: ['Ship the greeting module as-is.'],
      todos: [
        { text: 'Add integration tests for the API', detail: 'Cover the fetch path from the UI', priority: 'high' },
        { text: 'Write launch notes', priority: 'low' },
      ],
    }));
    const ended = await liveMeetings.endLiveMeeting(meeting.id);
    assert.equal(ended.status, 'ended');
    assert.equal(ended.title, 'Greeting module launch review', 'ended meetings take a content-derived display title');
    assert(ended.minutes);
    assert.equal(ended.minutes.direction, 'Harden the API layer before launch.');
    assert.equal(ended.minutes.decisions.length, 1);
    assert.equal(ended.minutes.todos.length, 2);
    assert.equal(ended.minutes.todos[0].priority, 'high');

    // 6) Todos → Board requires explicit confirmation and is idempotent.
    await assert.rejects(
      liveMeetings.convertLiveMeetingTodos({ meetingId: meeting.id, todoIds: ['todo-1'], confirmed: false }),
      /confirmation/i,
    );
    const converted = await liveMeetings.convertLiveMeetingTodos({ meetingId: meeting.id, todoIds: ['todo-1'], confirmed: true });
    const convertedTodo = converted.minutes!.todos.find((todo) => todo.id === 'todo-1');
    assert(convertedTodo?.boardTaskId, 'converted todo records its Board card');
    assert(convertedTodo.boardTaskKey);
    const again = await liveMeetings.convertLiveMeetingTodos({ meetingId: meeting.id, todoIds: ['todo-1'], confirmed: true });
    assert.equal(again.minutes!.todos.find((todo) => todo.id === 'todo-1')!.boardTaskId, convertedTodo.boardTaskId, 'conversion is idempotent');
    const cards = (await board.listBoardTasks()).filter((task) => task.labels.includes('meeting'));
    assert.equal(cards.length, 1, 'exactly one Board card exists for the converted todo');
    assert.equal(cards[0].title, 'Add integration tests for the API');
    assert.equal(cards[0].status, 'todo');
    assert(cards[0].description.includes('Greeting module launch review'), 'card description cites the meeting by its refined title');

    // 7) Unconverted todos stay off the Board; delete removes the meeting.
    assert.equal(converted.minutes!.todos.find((todo) => todo.id === 'todo-2')!.boardTaskId, undefined);
    liveMeetings.deleteLiveMeeting(meeting.id);
    assert.equal(liveMeetings.listLiveMeetings().length, 0);
    assert.equal((await board.listBoardTasks()).filter((task) => task.labels.includes('meeting')).length, 1, 'deleting a meeting keeps its Board cards');

    assert.equal(chatCalls, 5, 'exactly the scripted number of model calls happened');
    assert.equal(replies.length, 0, 'every scripted reply was consumed');

    console.log('verify-live-meetings: OK');
  } finally {
    oauth.setTokenFetcher(null);
  }
}

main().catch((error) => {
  console.error('verify-live-meetings: FAILED');
  console.error(error);
  process.exit(1);
});
