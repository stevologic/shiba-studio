import './verify-isolate'; // MUST be first: sandbox the data dir on direct runs
// Verifies per-agent Alpine sandbox containers: lifecycle (create/start/remove),
// command exec with in-container timeout, file writes, state persistence across
// calls, and the agent-tool dispatch wiring (including the cloud-agent block).
// Skips gracefully when Docker isn't available (e.g. slim CI runners).

import {
  detectDocker,
  ensureSandbox,
  sandboxExec,
  sandboxWriteFile,
  sandboxStatus,
  removeSandbox,
  sandboxContainerName,
} from '../lib/agent-sandbox';
import { executeAgentTool } from '../lib/agent-tool-exec';
import type { Agent } from '../lib/types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; } else console.log(`ok: ${msg}`);
}

function fixtureAgent(id: string, origin: 'local' | 'cloud'): Agent {
  return {
    id,
    name: 'Sandbox Verify Agent',
    origin,
    model: 'grok-3',
    description: '',
    workspace: { path: process.cwd(), useWorktree: false },
    integrations: {},
    peers: [],
    skills: [],
    schedules: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Agent;
}

async function main() {
  const probe = await detectDocker();
  if (!probe.available) {
    console.log('note: Docker not available on this machine — sandbox checks skipped (agents get a friendly error at runtime)');
    process.exit(0);
  }
  console.log(`Docker ${probe.version} detected`);

  const agentId = `sbx-test-${process.pid}-${Date.now()}`;
  console.log(`container under test: ${sandboxContainerName(agentId)}`);

  try {
    // --- lifecycle: lazy create ---
    const ensured = await ensureSandbox(agentId);
    assert(ensured.ok && ensured.created === true, 'first ensure creates the container');
    const again = await ensureSandbox(agentId);
    assert(again.ok && !again.created, 'second ensure reuses the running container');

    // --- resource guardrails: defaults, then a config change reconciles live ---
    const { execFileSync } = await import('child_process');
    const limitsOf = () => execFileSync(
      'docker',
      ['inspect', '-f', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}', sandboxContainerName(agentId)],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    assert(limitsOf() === `${512 * 1024 * 1024} ${1e9}`, 'container starts with default limits (512 MB / 1 CPU)');
    const { saveConfig } = await import('../lib/persistence');
    await saveConfig({ sandboxMemoryMb: 1024, sandboxCpus: 2 });
    const reconciled = await ensureSandbox(agentId);
    assert(reconciled.ok, 'ensure succeeds after limits change');
    assert(limitsOf() === `${1024 * 1024 * 1024} ${2e9}`, 'settings change reconciles the LIVE container (1 GB / 2 CPUs)');
    await saveConfig({ sandboxMemoryMb: 512, sandboxCpus: 1 });
    await ensureSandbox(agentId);
    assert(limitsOf() === `${512 * 1024 * 1024} ${1e9}`, 'limits reconcile back down without recreating the container');

    // --- it really is Alpine, with root and a /work cwd ---
    const os = await sandboxExec(agentId, 'cat /etc/os-release && whoami && pwd');
    assert(os.ok && os.stdout.includes('Alpine Linux'), 'container runs Alpine Linux');
    assert(os.stdout.includes('root'), 'agent has root inside the container');
    assert(os.stdout.includes('/work'), 'commands run in /work');

    // --- state persists across separate exec calls ---
    const w = await sandboxExec(agentId, 'echo sandbox-state-persists > proof.txt');
    assert(w.ok, 'write via exec succeeds');
    const r = await sandboxExec(agentId, 'cat proof.txt');
    assert(r.ok && r.stdout.includes('sandbox-state-persists'), 'files persist across exec calls');

    // --- sandbox_write_file: quoting-hostile content lands intact ---
    const script = '#!/bin/sh\necho "quotes \'and\' $(pwd) survive"\n';
    const wf = await sandboxWriteFile(agentId, 'scripts/echo.sh', script);
    assert(wf.ok && wf.path === '/work/scripts/echo.sh', `write_file lands under /work (${wf.path})`);
    const run = await sandboxExec(agentId, 'sh scripts/echo.sh');
    assert(run.ok && run.stdout.includes("quotes 'and' /work survive"), 'written script executes with content intact');

    // --- in-container timeout kills the command ---
    const slow = await sandboxExec(agentId, 'sleep 30', 1);
    assert(!slow.ok && slow.timedOut === true, 'timeout fires inside the container');

    // --- dispatch wiring (the exact path agent runs take) ---
    const local = fixtureAgent(agentId, 'local');
    const viaTool = await executeAgentTool('sandbox_exec', { command: 'echo via-dispatch' }, local, {}, process.cwd());
    const toolRes = viaTool.result as { ok?: boolean; stdout?: string };
    assert(toolRes.ok === true && (toolRes.stdout || '').includes('via-dispatch'), 'sandbox_exec dispatches through executeAgentTool');
    assert((viaTool.sideEffect || '').startsWith('sandbox:'), 'dispatch records a sandbox side-effect');

    const viaWrite = await executeAgentTool('sandbox_write_file', { path: 'notes.md', content: '# hi' }, local, {}, process.cwd());
    const writeRes = viaWrite.result as { ok?: boolean; path?: string };
    assert(writeRes.ok === true && writeRes.path === '/work/notes.md', 'sandbox_write_file dispatches through executeAgentTool');

    const cloud = fixtureAgent(`${agentId}-cloud`, 'cloud');
    const blocked = await executeAgentTool('sandbox_exec', { command: 'echo nope' }, cloud, {}, process.cwd());
    const blockedRes = blocked.result as { error?: string };
    assert(!!blockedRes.error && blockedRes.error.includes('local system access'), 'cloud agents are blocked from the sandbox');
  } finally {
    // --- teardown: agent deletion removes the container ---
    const rm = await removeSandbox(agentId);
    assert(rm.ok && rm.removed, 'removeSandbox deletes the container');
    const gone = await sandboxStatus(agentId);
    assert(gone.available && !gone.exists, 'status reports the container gone');
  }

  if (failures) { console.error(`\n${failures} sandbox checks FAILED`); process.exit(1); }
  console.log('\nALL SANDBOX CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('verify-sandbox crashed', e); process.exit(1); });
