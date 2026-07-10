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
  assert(bgLib.includes('deliverToChat'), 'background result delivery');
  assert((await read('lib/chat-sessions.ts')).includes('appendChatMessage'), 'lock-protected chat append');
  const chatStream = await read('app/api/grok/stream/route.ts');
  assert(chatStream.includes("'background_task'") && chatStream.includes("'background_status'"), 'background tools wired into chat');
  assert((await read('components/grok-chat-panel.tsx')).includes('sessionId: session?.id'), 'chat sends sessionId for delivery');

  // Prompt primacy: the user's message is the task; injected context is
  // subordinate reference material wrapped in <background_context>.
  assert(chatStream.includes('Task focus — read this first'), 'chat prompt-primacy preamble');
  assert(chatStream.includes('asBackgroundContext'), 'chat context wrapped as background');
  assert((await read('lib/agent-runtime.ts')).includes('<background_context source="integrations">'), 'agent runs wrap injected context');

  await log('PASS: all backlog feature structural checks');
  process.exit(0);
}

main().catch(async (e) => {
  await log(`FAIL: ${e.message || e}`);
  process.exit(1);
});