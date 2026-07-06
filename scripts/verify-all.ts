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
  'verify-runtime.ts',
  'verify-xai-oauth.ts',
  'verify-competitor-features.ts',
  'verify-backlog-features.ts',
  'verify-project-builder.ts',
] as const;

async function main() {
  process.env.GROK_GOAL_SCRATCH = GOAL_SCRATCH;
  await fs.mkdir(GOAL_SCRATCH, { recursive: true });

  const lines: string[] = [
    `FUNCTIONAL_VERIFY_START ${new Date().toISOString()}`,
    `SCRATCH=${GOAL_SCRATCH}`,
    '',
  ];

  let exitCode = 0;
  for (const script of CHAIN) {
    const started = Date.now();
    const result = spawnSync('npx', ['tsx', path.join('scripts', script)], {
      cwd: ROOT,
      env: { ...process.env, GROK_GOAL_SCRATCH: GOAL_SCRATCH },
      encoding: 'utf8',
      shell: true,
    });
    const elapsedMs = Date.now() - started;
    lines.push(`=== ${script} exit=${result.status ?? 1} elapsedMs=${elapsedMs} ===`);
    if (result.stdout) lines.push(result.stdout.trimEnd());
    if (result.stderr) lines.push(result.stderr.trimEnd());
    lines.push('');
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
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