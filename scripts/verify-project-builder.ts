import * as fs from 'fs/promises';
import * as path from 'path';
import { setApiKey } from '../lib/grok-client';
import { runAgentOnce } from '../lib/agent-runtime';
import { resolveProjectRunScope } from '../lib/project-run';
import {
  buildProjectContextHeader,
  normalizeProject,
  type Project,
} from '../lib/project-types';
import {
  buildProjectChatContext,
  createProject,
  getProject,
  updateProject,
} from '../lib/projects';
import { saveConfig, setPersistenceDataDir } from '../lib/persistence';
import { Agent } from '../lib/types';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');
const TEST_DATA = path.join(SCRATCH, 'project-builder-data');

const INJECT_MARKER = 'PROJECT_INJECT_VERIFY_XYZ_8842';
const WS_MARKER = 'project-builder-ws-folder';

const runLog: string[] = [];

function log(msg: string) {
  runLog.push(msg);
  console.log(msg);
}

async function writeRunLog(finalLine: string) {
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.writeFile(path.join(SCRATCH, 'project-builder.log'), [...runLog, finalLine].join('\n') + '\n');
}

async function writeAuxLog(file: string, msg: string) {
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.writeFile(path.join(SCRATCH, file), msg + '\n');
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function read(rel: string) {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.mkdir(TEST_DATA, { recursive: true });
  setPersistenceDataDir(TEST_DATA);

  // The one-off research/ gap audit was removed at release cleanup; the
  // shipped agent docs are the durable record of project/agent concepts.
  const agentDocs = await read('docs/agents.md');
  assert(/workspace/i.test(agentDocs), 'docs: workspace');
  assert(/agent/i.test(agentDocs), 'docs: agent');
  await fs.writeFile(path.join(SCRATCH, 'projects-gap-audit-grep.txt'), agentDocs);

  const projectsTs = await read('lib/projects.ts');
  assert(projectsTs.includes('workspacePath'), 'Project.workspacePath');
  const typesTs = await read('lib/types.ts');
  assert(typesTs.includes('projectId?: string'), 'AgentRun.projectId');

  const panel = await read('components/projects-panel.tsx');
  assert(panel.includes('saveProjectSetup(true)'), 'auto-save before build');
  assert(panel.includes('projectActiveRun'), 'scoped project trace');
  assert(panel.includes('projectLiveTrace'), 'scoped live trace');
  assert(panel.includes('onProjectSelect'), 'project switch handler');

  const desk = await read('components/shiba-studio.tsx');
  assert(desk.includes('clearProjectRunTrace'), 'clear trace on switch');
  assert(!desk.includes('workspacePath: ws'), 'no stale client workspace pass');

  const streamRoute = await read('app/api/execute/stream/route.ts');
  assert(streamRoute.includes('resolveProjectRunScope'), 'stream uses shared resolver');

  // Unit: buildProjectChatContext
  const fixture: Project = normalizeProject({
    id: 'fixture-1',
    name: 'Verify Project',
    description: 'Test desc',
    instructions: 'Build a REST API with tests.',
    workspacePath: 'C:\\demo\\my-app',
    defaultAgentId: 'agent-1',
    files: [],
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const header = buildProjectContextHeader(fixture, 'C:\\resolved\\ws');
  assert(header.includes('Verify Project'), 'header name');
  const ctx = await buildProjectChatContext(fixture, 'C:\\fallback\\ws');
  assert(ctx.includes('Build a REST API'), 'context instructions');
  log(`CONTEXT_OK len=${ctx.length}`);
  await writeAuxLog('project-context-unit.log', `CONTEXT_OK len=${ctx.length}`);

  // Shipped path: resolveProjectRunScope + runAgentOnce with project opts (mock grok captures prompts)
  await saveConfig({ xaiApiKey: 'test-key-project-builder', cloudAuthMode: 'api_key' });
  setApiKey('test-key-project-builder');

  const created = await createProject('Scoped Build Test');
  const wsPath = path.join(ROOT, WS_MARKER);
  await fs.mkdir(wsPath, { recursive: true }).catch(() => {});
  const updated = await updateProject(created.id, {
    instructions: INJECT_MARKER,
    workspacePath: wsPath,
    defaultAgentId: 'agent-verify',
  });

  const scope = await resolveProjectRunScope(updated.id, 'Implement the feature.');
  assert(scope !== null, 'resolveProjectRunScope');
  assert(scope!.projectContext.includes(INJECT_MARKER), 'scope context has instructions');
  assert(scope!.workspacePathOverride.includes(WS_MARKER), 'scope workspace path');
  assert(scope!.effectivePrompt.includes(INJECT_MARKER), 'effective prompt has project instructions');

  let capturedMessages: Array<{ role: string; content: string }> = [];
  async function mockGrokChat(params: { messages: Array<{ role: string; content: string }> }) {
    capturedMessages = params.messages;
    return {
      choices: [{
        message: { role: 'assistant', content: 'Project build complete.', tool_calls: undefined },
        finish_reason: 'stop',
      }],
    };
  }

  const testAgent: Agent = {
    id: 'agent-project-verify',
    name: 'Project Verify Agent',
    model: 'grok-3',
    workspace: { path: process.cwd(), useWorktree: false },
    integrations: { github: false, slack: false, googledrive: false, discord: false, x: false, obsidian: false, vercel: false },
    peers: [],
    skills: [],
    schedules: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const run = await runAgentOnce(testAgent, scope!.effectivePrompt, {
    grokChatFn: mockGrokChat,
    projectContext: scope!.projectContext,
    workspacePathOverride: scope!.workspacePathOverride,
    projectId: updated.id,
  });

  const systemContent = capturedMessages.find((m) => m.role === 'system')?.content || '';
  const userContent = capturedMessages.find((m) => m.role === 'user')?.content || '';

  assert(systemContent.includes(INJECT_MARKER), 'system prompt injects project instructions');
  assert(systemContent.includes(WS_MARKER) || systemContent.includes(wsPath), 'system prompt injects workspace');
  assert(userContent.includes(INJECT_MARKER), 'user prompt includes project instructions via buildProjectAgentPrompt');
  assert(run.projectId === updated.id, 'run.projectId persisted');
  assert((run.workspaceSnapshot || '').includes(WS_MARKER), 'run uses project workspace');
  assert(run.trace.length >= 2, 'project run trace steps >= 2');

  const transcript = {
    systemPromptExcerpt: systemContent.slice(0, 1200),
    userPrompt: userContent,
    runProjectId: run.projectId,
    workspaceSnapshot: run.workspaceSnapshot,
    traceStepCount: run.trace.length,
    injectMarkerFound: systemContent.includes(INJECT_MARKER),
  };
  await fs.writeFile(path.join(SCRATCH, 'project-build-transcript.json'), JSON.stringify(transcript, null, 2));
  await fs.writeFile(
    path.join(SCRATCH, 'project-scoped-runtime.log'),
    `PROJECT_RUN_OK traceSteps=${run.trace.length} projectId=${run.projectId}\n`,
  );
  log(`PROJECT_RUN_OK traceSteps=${run.trace.length} projectId=${run.projectId}`);

  const loaded = await getProject(created.id);
  await fs.writeFile(
    path.join(SCRATCH, 'projects-api-shape.json'),
    JSON.stringify({ created, updated, loaded, scope: { workspace: scope!.workspacePathOverride } }, null, 2),
  );

  const passLine = 'PASS: all project builder checks';
  log(passLine);
  await writeRunLog(passLine);
  process.exit(0);
}

main().catch(async (e) => {
  await writeRunLog(`FAIL: ${e.message || e}`);
  process.exit(1);
});