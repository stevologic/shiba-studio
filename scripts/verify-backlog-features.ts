import * as fs from 'fs/promises';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
const LOG = path.join(SCRATCH, 'backlog-features.log');

async function log(msg: string) {
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, msg + '\n');
  console.log(msg);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function read(rel: string) {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.writeFile(LOG, `verify-backlog-features ${new Date().toISOString()}\n`);

  assert((await read('lib/workspace.ts')).includes('listWorktrees'), 'worktree list');
  assert((await read('app/api/workspace/worktrees/route.ts')).includes('ensureWorktree'), 'worktree API');

  assert((await read('lib/skills-catalog.ts')).includes('SKILL_PRESETS'), 'skills catalog');
  assert((await read('components/skills-browser.tsx')).includes('SkillsBrowser'), 'skills browser UI');

  assert((await read('lib/chat-sessions.ts')).includes('searchChatSessions'), 'session search');
  assert((await read('lib/chat-sessions.ts')).includes('archiveChatSession'), 'session archive');
  assert((await read('components/chat-sessions-panel.tsx')).includes('Search sessions'), 'session search UI');

  assert((await read('lib/tool-approval.ts')).includes('toolNeedsApproval'), 'tool approval');
  assert((await read('app/api/execute/approve/route.ts')).includes('resolveToolApproval'), 'approve API');
  assert((await read('components/tool-approval-modal.tsx')).includes('Approve tool execution'), 'approval modal');

  assert((await read('components/preview-rail.tsx')).includes('Preview Rail'), 'preview rail');

  assert((await read('lib/global-instructions.ts')).includes('readAgentsMd'), 'AGENTS.md loader');
  assert((await read('lib/agent-runtime.ts')).includes('buildGlobalInstructionsContext'), 'runtime global instructions');

  assert((await read('components/multitask-sidebar.tsx')).includes('MultitaskSidebar'), 'multitask sidebar');

  const types = await read('lib/types.ts');
  assert(types.includes('toolApprovalMode'), 'ToolApprovalMode in types');
  assert(types.includes('globalInstructions'), 'globalInstructions in types');

  // Chat background tasks: dispatch tool + result delivery back into the session.
  const bgLib = await read('lib/background-tasks.ts');
  assert(bgLib.includes('startBackgroundTask'), 'background task dispatch');
  assert(bgLib.includes('processTaskOutbox'), 'background completion pumps the durable delivery outbox');
  const taskDelivery = await read('lib/task-delivery.ts');
  assert(taskDelivery.includes('claimOutbox') && taskDelivery.includes('appendChatMessage'), 'background result delivery is durable and idempotent');
  assert((await read('lib/chat-sessions.ts')).includes('appendChatMessage'), 'lock-protected chat append');
  const chatStream = await read('app/api/grok/stream/route.ts');
  assert(chatStream.includes("'background_task'") && chatStream.includes("'background_status'"), 'background tools wired into chat');
  assert((await read('components/grok-chat-panel.tsx')).includes('sessionId: session?.id'), 'chat sends sessionId for delivery');

  // Prompt primacy: the user's message is the task; injected context is
  // subordinate reference material wrapped in <background_context>.
  assert(chatStream.includes('Task focus — read this first'), 'chat prompt-primacy preamble');
  assert(chatStream.includes('asBackgroundContext'), 'chat context wrapped as background');
  assert((await read('lib/agent-runtime.ts')).includes('<background_context source="integrations">'), 'agent runs wrap injected context');

  // Kanban board: shared store, agent tools, run dispatch, Linear-style UI.
  assert((await read('lib/board.ts')).includes('moveBoardTask'), 'board store');
  assert((await read('lib/board-runner.ts')).includes('startWorkOnTask'), 'board run dispatch');
  const runtimeSrc = await read('lib/agent-runtime.ts');
  for (const t of ['board_list_tasks', 'board_get_task', 'board_update_task', 'board_create_task']) {
    assert(runtimeSrc.includes(`'${t}'`), `agent tool ${t}`);
  }
  assert((await read('lib/agent-tool-exec.ts')).includes("case 'board_update_task'"), 'board tool exec');
  const kanbanUi = await read('components/kanban-board.tsx');
  assert(kanbanUi.includes('Start work'), 'kanban UI');
  assert((await read('lib/app-navigation.ts')).includes("'board'"), 'board nav tab');

  // Board review stage: user validates In Review work into Done, or sends it
  // back with feedback that re-dispatches the assigned agent as a refinement.
  const boardApi = await read('app/api/board/route.ts');
  assert(boardApi.includes("case 'validate'"), 'board validate action');
  assert(boardApi.includes("case 'refine'"), 'board refine action');
  assert((await read('lib/board-runner.ts')).includes('feedback'), 'refinement feedback reaches the run prompt');
  assert(kanbanUi.includes('kb-review'), 'review UI on In Review cards');
  assert((await read('lib/nav-stats-types.ts')).includes('boardOpen'), 'board open count in nav stats');
  assert(kanbanUi.includes('kb-open-pill'), 'board open-count pill');

  // Secret masking: full keys never reach the browser — GETs return partial
  // fingerprints; masked values round-tripping back are restored server-side.
  const maskLib = await read('lib/secret-mask.ts');
  assert(maskLib.includes('maskSecret') && maskLib.includes('restoreMaskedCreds'), 'secret-mask helpers');
  const intsRoute = await read('app/api/integrations/route.ts');
  assert(intsRoute.includes('maskIntegrationCreds'), 'integrations GET masks secrets');
  assert(intsRoute.includes('restoreMaskedCreds'), 'integrations save/test restore masked values');
  const cfgRoute = await read('app/api/config/route.ts');
  assert(cfgRoute.includes('maskIntegrationCreds'), 'config GET masks integration secrets');
  assert(cfgRoute.includes('maskSecret'), 'config GET masks xAI keys');
  assert((await read('app/api/mcp/route.ts')).includes('sanitizeIncomingEnv'), 'mcp env mask round-trip');
  assert((await read('components/shiba-studio.tsx')).includes('isMaskedSecret'), 'settings inputs treat masks as placeholders');

  // Board "View work": answer + deliverable files behind Done cards, files
  // served only through the owning card (capability check).
  const boardWork = await read('lib/board-work.ts');
  assert(boardWork.includes('collectCardWork'), 'card work collection');
  assert(boardWork.includes('resolveCardDeliverable'), 'deliverable capability check');
  assert((await read('app/api/board/work/route.ts')).includes('resolveCardDeliverable'), 'work file endpoint validates path');
  assert((await read('components/kanban-board.tsx')).includes('View work'), 'view-work UI');
  assert((await read('lib/agent-runs-store.ts')).includes('workspaceSnapshot'), 'runs store persists workspace');
  assert((await read('lib/db.ts')).includes('addRunsWorkspaceColumn'), 'workspaceSnapshot migration');

  // Voice barge-in: acoustic VAD is the trigger; transcription only confirms.
  const vadLib = await read('lib/voice-vad.ts');
  assert(vadLib.includes('createVadDetector') && vadLib.includes('startVoiceVad'), 'voice VAD module');
  assert(vadLib.includes('echoCancellation: true'), 'VAD stream uses echo cancellation');
  const chatPanel = await read('components/grok-chat-panel.tsx');
  assert(chatPanel.includes('startVoiceVad'), 'chat panel starts the VAD with voice mode');
  assert(chatPanel.includes('!vadActiveRef.current && hasWords'), 'transcript trigger is fallback-only');

  // Live UI: stores emit on change, SSE fans out, shell + board subscribe.
  assert((await read('lib/app-events.ts')).includes('emitAppEvent'), 'server change bus');
  assert((await read('app/api/events/route.ts')).includes('text/event-stream'), 'SSE endpoint');
  for (const [file, label] of [
    ['lib/agent-runs-store.ts', 'runs emit'],
    ['lib/board.ts', 'board emit'],
    ['lib/chat-sessions.ts', 'chats emit'],
    ['lib/persistence.ts', 'agents emit'],
  ] as const) {
    assert((await read(file)).includes('emitAppEvent'), label);
  }
  assert((await read('lib/live-events.ts')).includes('EventSource'), 'client event feed');
  assert((await read('components/shiba-studio.tsx')).includes('subscribeLiveEvents'), 'shell subscribes live');
  assert((await read('components/kanban-board.tsx')).includes('subscribeLiveEvents'), 'board subscribes live');

  // Context hygiene: explicit truncation markers, grounded dates, untrusted
  // wrapping on every prompt surface, no-fabrication synthesis rules.
  const hygiene = await read('lib/prompt-hygiene.ts');
  assert(hygiene.includes('clipForModel') && hygiene.includes('environmentFacts') && hygiene.includes('asUntrustedContext'), 'prompt-hygiene helpers');
  const streamRoute = await read('app/api/grok/stream/route.ts');
  assert(streamRoute.includes('environmentFacts()'), 'chat prompts carry the current date');
  assert(streamRoute.includes('clipForModel(JSON.stringify'), 'chat tool results clip with markers');
  assert(streamRoute.includes('prepareSessionContext'), 'chat history uses the bounded durable context engine');
  const contextEngine = await read('lib/context-engine.ts');
  assert(contextEngine.includes('Earlier turns were bounded for this request') && contextEngine.includes('deterministic compactions'), 'chat history caps with an explicit omission/compaction record');
  assert(streamRoute.includes('## Grounding'), 'chat grounding rules');
  const runtime2 = await read('lib/agent-runtime.ts');
  assert(runtime2.includes('environmentFacts()'), 'agent runs carry the current date');
  assert(runtime2.includes('clipForModel(JSON.stringify'), 'run tool results clip with markers');
  assert(runtime2.includes('Grounding:'), 'agent run grounding rules');
  assert((await read('lib/multi-agent-chat.ts')).includes('asUntrustedContext'), 'multi-agent wraps integration context');
  assert((await read('lib/chat-skill.ts')).includes('Faithfulness rules'), 'synthesis no-fabrication rules');
  assert((await read('lib/agent-power-tools.ts')).includes('clipForModel'), 'web fetch clips with markers');

  await log('PASS: all backlog feature structural checks');
  process.exit(0);
}

main().catch(async (e) => {
  await log(`FAIL: ${e.message || e}`);
  process.exit(1);
});
