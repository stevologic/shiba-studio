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
    /** SSE bodies served for `/v1/responses` streaming calls (grok-4 streams there). */
    const streamReplies: string[] = [];
    const chatRequests: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    let chatCalls = 0;
    let pendingGate: Promise<void> | null = null;
    oauth.setTokenFetcher(async (input, init) => {
      const url = String(input);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xai-verifier-key', 'cloud auth stays server-side');
      chatRequests.push(JSON.parse(String(init?.body || '{}')));
      chatCalls++;
      if (pendingGate) {
        const gate = pendingGate;
        pendingGate = null;
        await gate;
      }
      if (url.endsWith('/responses')) {
        const sse = streamReplies.shift();
        assert(sse, 'streaming model was called more times than the script expects');
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      assert(url.endsWith('/chat/completions'), `unexpected xAI endpoint ${url}`);
      const next = replies.shift();
      assert(next, 'model was called more times than the script expects');
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(next()) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    // Progressive-say extractor: decodes escapes and holds back incomplete ones.
    assert.equal(liveMeetings.extractPartialSay('{"say":"Hello wo'), 'Hello wo');
    assert.equal(liveMeetings.extractPartialSay('{"say":"Line\\'), 'Line', 'incomplete escape is held back until more tokens arrive');
    assert.equal(liveMeetings.extractPartialSay('{"say":"A\\nB","visual":null}'), 'A\nB');
    assert.equal(liveMeetings.extractPartialSay('no say yet'), '');

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
      (chatRequests[1].messages || []).some((message) => message.role === 'assistant' && message.content.includes('export function greet')),
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
    const stageMessages = chatRequests[2].messages;
    assert(stageMessages?.length, 'stage-focused turn request carries messages');
    const stageSystem = stageMessages[0];
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

    // 4b) Streaming turn: progressive say deltas over the responses SSE path,
    //     then a settled durable turn with suggestions.
    const sayFull = 'Streaming feels immediate. We can keep the review moving.';
    const streamJson = JSON.stringify({ say: sayFull, visual: null, suggestions: ['Keep going'] });
    const cutA = 18;
    const cutB = 41;
    streamReplies.push(
      [streamJson.slice(0, cutA), streamJson.slice(cutA, cutB), streamJson.slice(cutB)]
        .map((delta) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    );
    const turnsBeforeStream = (liveMeetings.getLiveMeeting(meeting.id)!).turns.length;
    const streamEvents: Array<import('../lib/live-meeting-types').LiveMeetingStreamEvent> = [];
    for await (const event of liveMeetings.streamLiveMeetingTurn(meeting.id, 'How does streaming feel?')) {
      streamEvents.push(event);
    }
    assert.equal(streamEvents[0]?.type, 'status', 'stream opens with a thinking status');
    const sayEvents = streamEvents.filter(
      (event): event is Extract<import('../lib/live-meeting-types').LiveMeetingStreamEvent, { type: 'say' }> => event.type === 'say',
    );
    assert(sayEvents.length >= 2, 'spoken text streams across multiple deltas');
    assert.equal(sayEvents.map((event) => event.delta).join(''), sayFull, 'say deltas reassemble the full spoken text');
    assert.equal(sayEvents[sayEvents.length - 1].text, sayFull);
    const meetingEvent = streamEvents.find(
      (event): event is Extract<import('../lib/live-meeting-types').LiveMeetingStreamEvent, { type: 'meeting' }> => event.type === 'meeting',
    );
    assert(meetingEvent, 'stream settles into a durable meeting record');
    assert.equal(meetingEvent.meeting.turns.length, turnsBeforeStream + 2, 'creator turn and streamed agent turn are durable');
    const streamedTurn = meetingEvent.meeting.turns[meetingEvent.meeting.turns.length - 1];
    assert.equal(streamedTurn.role, 'agent');
    assert.equal(streamedTurn.text, sayFull);
    assert.deepEqual(streamedTurn.suggestions, ['Keep going']);
    assert.equal(streamEvents[streamEvents.length - 1]?.type, 'done');
    assert(
      JSON.stringify(chatRequests[chatRequests.length - 1]).includes('export function greet'),
      'the streaming request also carries recent visual content',
    );

    // 5) End → minutes with a refined display title, direction, decisions, todos.
    replies.push(() => ({
      title: 'Greeting module launch review',
      summary: 'We reviewed the greeting module and the architecture.',
      direction: 'Harden the API layer before launch.',
      decisions: ['Ship the greeting module as-is.'],
      todos: [
        { text: 'Add integration tests for the API', detail: 'Cover the fetch path from the UI', priority: 'high', owner: 'Review engineer' },
        { text: 'Write launch notes', priority: 'low' },
        { text: 'Prepare a demo script', owner: 'Alex' },
      ],
    }));
    const ended = await liveMeetings.endLiveMeeting(meeting.id);
    assert.equal(ended.status, 'ended');
    assert.equal(ended.title, 'Greeting module launch review', 'ended meetings take a content-derived display title');
    assert(ended.minutes);
    assert.equal(ended.minutes.direction, 'Harden the API layer before launch.');
    assert.equal(ended.minutes.decisions.length, 1);
    assert.equal(ended.minutes.todos.length, 3);
    assert.equal(ended.minutes.todos[0].priority, 'high');
    assert.equal(ended.minutes.todos[0].owner, 'Review engineer', 'explicit meeting assignments are captured as todo owners');
    assert(
      JSON.stringify(chatRequests[chatRequests.length - 1]).includes('Agent roster: Review engineer'),
      'the minutes prompt lists the agent roster for owner attribution',
    );

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
    assert.equal(cards[0].assigneeAgentId, 'agent-reviewer', 'a todo owner naming a real agent becomes the card assignee');

    // 6b) An owner with no matching agent stays unassigned but is recorded.
    const withUnmatched = await liveMeetings.convertLiveMeetingTodos({ meetingId: meeting.id, todoIds: ['todo-3'], confirmed: true });
    const alexTodo = withUnmatched.minutes!.todos.find((todo) => todo.id === 'todo-3')!;
    assert(alexTodo.boardTaskId, 'unmatched-owner todo still converts');
    const alexCard = (await board.listBoardTasks()).find((task) => task.id === alexTodo.boardTaskId)!;
    assert.equal(alexCard.assigneeAgentId, null, 'an owner that matches no agent leaves the card unassigned');
    assert(alexCard.description.includes('Owner named in the meeting: Alex'), 'the named owner is preserved in the card description');
    assert(alexCard.description.includes('no matching agent'), 'the description explains why the card is unassigned');

    // 7) Unconverted todos stay off the Board; delete removes the meeting and scrubs its payload.
    assert.equal(converted.minutes!.todos.find((todo) => todo.id === 'todo-2')!.boardTaskId, undefined);
    liveMeetings.deleteLiveMeeting(meeting.id);
    assert.equal(liveMeetings.listLiveMeetings().length, 0);
    assert.equal(liveMeetings.getLiveMeeting(meeting.id), null, 'deleted meeting is hidden from reads');
    const { getDb } = await import('../lib/db');
    const tombstone = getDb().prepare('SELECT turns, minutes, brief, pendingTurn, deletedAt FROM live_meetings WHERE id = ?')
      .get(meeting.id) as { turns: string; minutes: string | null; brief: string; pendingTurn: number; deletedAt: string | null };
    assert(tombstone, 'soft-delete keeps a tombstone row');
    assert(tombstone.deletedAt, 'deletedAt is set');
    assert.equal(tombstone.turns, '[]', 'delete scrubs transcript turns (incl. any screenshot payloads)');
    assert.equal(tombstone.minutes, null, 'delete scrubs minutes');
    assert.equal(tombstone.brief, '', 'delete scrubs the project brief');
    assert.equal(tombstone.pendingTurn, 0, 'delete clears any in-flight turn claim');
    assert.equal((await board.listBoardTasks()).filter((task) => task.labels.includes('meeting')).length, 2, 'deleting a meeting keeps its Board cards');

    assert.equal(chatCalls, 6, 'exactly the scripted number of model calls happened');
    assert.equal(replies.length, 0, 'every scripted reply was consumed');
    assert.equal(streamReplies.length, 0, 'every scripted streaming reply was consumed');

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
