/**
 * Runs the full npm test chain with GROK_GOAL_SCRATCH set and writes a single
 * coherent functional-npm-test.log (no mixed scratch paths or stale reruns).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(GOAL_SCRATCH, 'functional-npm-test.log');

const CHAIN = [
  'verify-theme.ts',
  'verify-page-chrome.ts',
  'verify-runtime.ts',
  'verify-tool-dispatch.ts',
  'verify-persistence-safety.ts',
  'verify-memory-learning.ts',
  'verify-mdns.ts',
  'verify-voice-vad.ts',
  'verify-shell-state.ts',
  'verify-xai-oauth.ts',
  'verify-competitor-features.ts',
  'verify-backlog-features.ts',
  'verify-project-builder.ts',
  'verify-netlify.ts',
  'verify-board-sync.ts',
] as const;

async function main() {
  process.env.GROK_GOAL_SCRATCH = GOAL_SCRATCH;
  await fs.mkdir(GOAL_SCRATCH, { recursive: true });

  // Isolate ALL persistence from the live install: every child script gets a
  // fresh SHIBA_DATA_DIR under scratch, so `npm test` never mutates
  // ~/.shiba-studio/data (agents, runs, chats) again. Override with
  // SHIBA_TEST_DATA_DIR if you deliberately want a persistent test store.
  const testDataDir = process.env.SHIBA_TEST_DATA_DIR
    || path.join(GOAL_SCRATCH, `test-data-${Date.now()}`);
  process.env.SHIBA_DATA_DIR = testDataDir;
  await fs.mkdir(testDataDir, { recursive: true });

  const lines: string[] = [
    `FUNCTIONAL_VERIFY_START ${new Date().toISOString()}`,
    `SCRATCH=${GOAL_SCRATCH}`,
    '',
  ];

  let exitCode = 0;
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  for (const script of CHAIN) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [tsxCli, path.join('scripts', script)], {
      cwd: ROOT,
      env: { ...process.env, GROK_GOAL_SCRATCH: GOAL_SCRATCH },
      encoding: 'utf8',
      shell: false,
    });
    const elapsedMs = Date.now() - started;
    // Node-on-Windows libuv can assert during process-exit teardown
    // (STATUS_STACK_BUFFER_OVERRUN, "async.c" UV_HANDLE_CLOSING) AFTER a
    // script has finished and printed its success summary. Treat that
    // specific teardown crash as a pass when the success marker is present.
    const teardownCrash =
      result.status === 3221226505
      && /(\d+) passed, 0 failed/.test(result.stdout || '')
      && !/[1-9]\d* failed/.test(result.stdout || '');
    const effectiveStatus = teardownCrash ? 0 : (result.status ?? 1);
    lines.push(`=== ${script} exit=${effectiveStatus} elapsedMs=${elapsedMs}${teardownCrash ? ' (libuv teardown crash ignored — all tests passed)' : ''} ===`);
    if (result.stdout) lines.push(result.stdout.trimEnd());
    if (result.stderr) lines.push(result.stderr.trimEnd());
    if (result.error) lines.push(result.error.stack || result.error.message);
    lines.push('');
    if (effectiveStatus !== 0) {
      exitCode = effectiveStatus;
      // Echo the failing script's captured output so CI logs (which only see
      // this process's stdout, not the per-script log file) show the real error.
      console.error(`\n===== FAILED: ${script} (exit ${effectiveStatus}) =====`);
      if (result.stdout) console.error(result.stdout.trimEnd());
      if (result.stderr) console.error(result.stderr.trimEnd());
      if (result.error) console.error(result.error.stack || result.error.message);
      console.error(`===== end ${script} =====\n`);
      break;
    }
  }

  lines.push(`NPM_TEST_EXIT_CODE=${exitCode}`);
  lines.push(`FUNCTIONAL_VERIFY_END ${new Date().toISOString()}`);
  await fs.writeFile(LOG, lines.join('\n') + '\n');

  if (exitCode === 0) {
    const pbLog = await fs.readFile(path.join(GOAL_SCRATCH, 'project-builder.log'), 'utf8').catch(() => '');
    const transcript = await fs.readFile(path.join(GOAL_SCRATCH, 'project-build-transcript.json'), 'utf8').catch(() => '{}');
    const runIdMatch = pbLog.match(/PROJECT_RUN_OK traceSteps=\d+ projectId=([a-f0-9-]+)/);
    const transcriptId = JSON.parse(transcript).runProjectId as string | undefined;
    if (runIdMatch && transcriptId && runIdMatch[1] !== transcriptId) {
      console.error(`ARTIFACT_MISMATCH project-builder.log=${runIdMatch[1]} transcript=${transcriptId}`);
      process.exit(2);
    }
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('verify-all failed', e);
  process.exit(1);
});
