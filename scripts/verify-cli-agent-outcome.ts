import './verify-isolate'; // MUST be first: runtime checks never touch live Studio data.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentOnce, type AgentRunOpts } from '../lib/agent-runtime';
import { getTask } from '../lib/task-ledger';
import { saveConfig } from '../lib/persistence';
import {
  GROK_BUILD_OPEN_SOURCE,
  type GrokCliStatus,
} from '../lib/grok-cli';
import type { Agent, AgentRun } from '../lib/types';
import {
  assessCliAgentCompletion,
  isIncompleteCliAgentOutput,
} from '../lib/cli-agent-outcome';
import {
  captureGitWorkspaceSnapshot,
  collectGitWorkspaceChanges,
} from '../lib/workspace-change-tracker';
import { classifyWorkRunDelivery } from '../lib/board-work';

const LIVE_PROMISE_ONLY_OUTPUTS = [
  "I'll pull the SHIB-14 card details and discover the board tools so we can analyze the repo systematically.",
  "I'll start by reading the SHIB-19 card and discovering the board tools so we can work it to completion.",
  "I'll start by reading the SHIB-7 card and locating the security-recipes.ai site code so we can implement analytics and lead capture.",
] as const;

const READY_CLI: GrokCliStatus = {
  installed: true,
  ready: true,
  path: 'mock-grok',
  explicitlyTrusted: true,
  discovery: 'explicit',
  version: '0.2.103',
  versionNumber: '0.2.103',
  authenticated: true,
  capabilities: {
    headless: true,
    streamingJson: true,
    acpStdio: true,
    acpWebSocket: true,
    sessions: true,
    worktrees: true,
    toolFiltering: true,
    permissionRules: true,
    sandbox: true,
    mcp: true,
    plugins: true,
    selfVerification: true,
    bestOfN: true,
    structuredOutput: true,
  },
  source: GROK_BUILD_OPEN_SOURCE,
};

function cliAgent(workspace: string): Agent {
  return {
    id: 'verify-cli-agent-outcome',
    name: 'CLI outcome verifier',
    model: 'cli:grok-build',
    autoAcceptBoardAssignments: true,
    workspace: { path: workspace, useWorktree: false },
    integrations: {
      github: false,
      slack: false,
      googledrive: false,
      discord: false,
      x: false,
      reddit: false,
      obsidian: false,
      vercel: false,
      netlify: false,
    },
    peers: [],
    skills: [],
    learning: { mode: 'off', autoRecall: false, maxMemories: 20 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function workRunFixture(status: AgentRun['status'], finalOutput: string): AgentRun {
  return {
    id: `fixture-${status}`,
    agentId: 'verify-cli-agent-outcome',
    agentName: 'CLI outcome verifier',
    prompt: 'Complete the Board card.',
    model: 'cli:grok-build',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status,
    trace: [],
    finalOutput,
    sideEffects: [],
  };
}

async function verifyWorkspaceChangeEvidence() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-cli-evidence-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  try {
    git('init');
    git('config', 'user.email', 'verify@shiba.local');
    git('config', 'user.name', 'Shiba Verify');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
    await fs.writeFile(path.join(root, 'already-dirty.txt'), 'clean\n');
    git('add', '.');
    git('commit', '-m', 'fixture');

    await fs.writeFile(path.join(root, 'already-dirty.txt'), 'dirty before the run\n');
    const before = await captureGitWorkspaceSnapshot(root);
    await fs.writeFile(path.join(root, 'base.txt'), 'changed by the CLI run\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'created by the CLI run\n');
    git('add', '.');
    git('commit', '-m', 'simulated CLI work');

    const changed = await collectGitWorkspaceChanges(before);
    const changedPaths = changed.map((item) => item.path.replaceAll('\\', '/')).sort();
    assert(changedPaths.includes('base.txt'), 'a committed tracked-file edit is captured as CLI evidence');
    assert(changedPaths.includes('new.txt'), 'a committed new file is captured as CLI evidence');
    assert(!changedPaths.includes('already-dirty.txt'), 'an unchanged pre-existing dirty file is not attributed to the CLI run');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function verifyStructuredCliRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-cli-runtime-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  try {
    git('init');
    git('config', 'user.email', 'verify@shiba.local');
    git('config', 'user.name', 'Shiba Verify');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(root, 'README.md'), '# Runtime fixture\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    await saveConfig({ toolApprovalMode: 'ask', defaultWorkspace: root });

    let askStreamCalled = false;
    const askStream: NonNullable<AgentRunOpts['grokCliStreamFn']> = async function* () {
      askStreamCalled = true;
      yield { type: 'done', model: 'cli:grok-build' };
    };
    const askBlockedRun = await runAgentOnce(cliAgent(root), 'Complete the Board card.', {
      taskKind: 'board',
      grokCliStatusOverride: READY_CLI,
      grokCliStreamFn: askStream,
    });
    assert.equal(askBlockedRun.status, 'error', 'Ask-mode background CLI Board work fails closed');
    assert.match(askBlockedRun.finalOutput || '', /cannot run unattended while tool approval is set to Ask/i);
    assert.equal(askStreamCalled, false, 'Ask-mode Board work is rejected before the host CLI launches');
    assert.equal(getTask(askBlockedRun.taskId!)?.status, 'failed', 'the failed-closed Board run remains out of review');

    await saveConfig({ toolApprovalMode: 'yolo', defaultWorkspace: root });

    let promiseOptions: Parameters<NonNullable<AgentRunOpts['grokCliStreamFn']>>[0] | undefined;
    const promiseOnlyStream: NonNullable<AgentRunOpts['grokCliStreamFn']> = async function* (opts) {
      promiseOptions = opts;
      yield { type: 'thinking', delta: 'Planning the first step.' };
      yield { type: 'content', delta: LIVE_PROMISE_ONLY_OUTPUTS[0] };
      yield { type: 'done', model: 'cli:grok-build' };
    };
    const promiseOnlyRun = await runAgentOnce(cliAgent(root), 'Complete the Board card.', {
      taskKind: 'board',
      grokCliStatusOverride: READY_CLI,
      grokCliStreamFn: promiseOnlyStream,
    });
    assert.equal(promiseOnlyRun.status, 'error', 'exit-zero promise-only CLI output is not marked completed');
    assert.match(promiseOnlyRun.finalOutput || '', /stopped before delivering completed work/i);
    assert.equal(getTask(promiseOnlyRun.taskId!)?.status, 'failed', 'promise-only CLI work does not promote its durable task');
    assert.equal(promiseOptions?.permissionMode, 'bypassPermissions', 'only explicit YOLO reaches unattended CLI approval');
    assert(
      promiseOptions?.allowedTools?.includes('search_replace')
        && promiseOptions.allowedTools.includes('run_terminal_cmd')
        && promiseOptions.allowedTools.includes('read_file'),
      'YOLO Board work receives an explicit built-in coding-tool allowlist',
    );
    assert(
      promiseOptions?.disallowedTools?.includes('Agent')
        && promiseOptions.denyRules?.includes('MCPTool')
        && promiseOptions.denyRules.includes('WebFetch'),
      'Board CLI work removes subagents and ambient MCP/web surfaces',
    );
    assert.equal(promiseOptions?.scoped, true, 'Board CLI work enables scoped memory/subagent/web flags');
    assert.equal(
      promiseOptions?.env?.GROK_CLAUDE_MCPS_ENABLED,
      'false',
      'Board CLI work disables vendor compatibility MCP discovery',
    );
    assert.equal(promiseOptions?.check, true, 'Board CLI work enables Grok self-verification');

    let deliveredOptions: Parameters<NonNullable<AgentRunOpts['grokCliStreamFn']>>[0] | undefined;
    const deliveredStream: NonNullable<AgentRunOpts['grokCliStreamFn']> = async function* (opts) {
      deliveredOptions = opts;
      yield { type: 'thinking', delta: "I'll inspect the file first." };
      await fs.writeFile(path.join(opts.cwd!, 'runtime-change.ts'), 'export const fixed = true;\n');
      yield {
        type: 'content',
        delta: 'Implemented the runtime fix in runtime-change.ts. Validation: typecheck passed.',
      };
      yield { type: 'done', model: 'cli:grok-build' };
    };
    const deliveredRun = await runAgentOnce(cliAgent(root), 'Complete the Board card.', {
      taskKind: 'board',
      grokCliStatusOverride: READY_CLI,
      grokCliStreamFn: deliveredStream,
    });
    assert.equal(deliveredRun.status, 'completed', 'substantive structured CLI output completes normally');
    assert.match(deliveredRun.finalOutput || '', /Implemented the runtime fix/);
    assert(!deliveredRun.finalOutput?.includes("I'll inspect"), 'thinking text never replaces the delivered final answer');
    assert(
      deliveredRun.trace.some((step) => step.tool?.name === 'workspace_change'
        && (step.tool.result as { path?: string } | undefined)?.path === 'runtime-change.ts'),
      'a CLI-created file is persisted as run evidence',
    );
    assert(deliveredRun.sideEffects.includes('changed runtime-change.ts'), 'the CLI workspace change is retained as a side effect');
    assert.equal(getTask(deliveredRun.taskId!)?.status, 'succeeded', 'substantive CLI work projects to task success');
    assert.equal(deliveredOptions?.permissionMode, 'bypassPermissions', 'the delivered Board run used the explicit YOLO setting');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  for (const output of LIVE_PROMISE_ONLY_OUTPUTS) {
    assert.deepEqual(
      assessCliAgentCompletion(output),
      { complete: false, reason: 'intent-only' },
      `live promise-only response must be incomplete: ${output}`,
    );
  }

  for (const output of [
    '  ',
    'Sure — I’ll begin by inspecting the workspace and then make the requested changes.',
    'First, I will read the card and locate the relevant source files.',
    'Let me pull the task details before I start.',
    [
      "I'll take care of this in three steps:",
      '1. Inspect the board data.',
      '2. Update the work view.',
      '3. Run the tests.',
    ].join('\n'),
  ]) {
    assert.equal(
      isIncompleteCliAgentOutput(output),
      true,
      `empty or future-intent-only response must be incomplete: ${JSON.stringify(output)}`,
    );
  }
  assert.deepEqual(
    assessCliAgentCompletion('Unable to continue because the repository is read-only.'),
    { complete: false, reason: 'blocked' },
    'a blocker report is not promoted as completed Board work',
  );
  assert.equal(
    classifyWorkRunDelivery(workRunFixture('completed', LIVE_PROMISE_ONLY_OUTPUTS[0]), []).deliveryState,
    'not_delivered',
    'historical promise-only runs render as not delivered',
  );
  assert.equal(
    classifyWorkRunDelivery(
      workRunFixture('error', 'Grok CLI stopped before delivering completed work. No completed result was recorded.'),
      [],
    ).deliveryState,
    'not_delivered',
    'a rejected CLI run with no evidence renders as not delivered rather than partial',
  );
  assert.equal(
    classifyWorkRunDelivery(workRunFixture('error', 'The run stopped during validation.'), [{
      kind: 'change',
      label: 'Changed lib/example.ts',
    }]).deliveryState,
    'partial',
    'an errored run with concrete change evidence remains visible as partial work',
  );

  for (const output of [
    'Implemented the work-view fix in components/kanban-board.tsx. Tests: 12 passed.',
    "I'll summarize what I completed: fixed the modal, added trace evidence, and verified the focused tests.",
    'Root cause: the bug is that the modal only renders finalOutput. The trace evidence is never exposed.',
    'No files changed. I reviewed the data path and confirmed the existing implementation is correct.',
  ]) {
    assert.deepEqual(
      assessCliAgentCompletion(output),
      { complete: true, reason: 'substantive' },
      `concrete result must remain eligible for normal completion handling: ${output}`,
    );
  }

  await verifyWorkspaceChangeEvidence();
  await verifyStructuredCliRuntime();
  console.log('CLI agent outcome verification passed: 39 assertions, 0 failed');
}

main().catch((error) => {
  console.error('CLI agent outcome verification failed', error);
  process.exit(1);
});
