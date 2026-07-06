/** Runs npm run build and writes functional-build.log with explicit exit marker. */
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

const LOG = path.join(GOAL_SCRATCH, 'functional-build.log');

async function main() {
  await fs.mkdir(GOAL_SCRATCH, { recursive: true });
  const startedAt = new Date().toISOString();
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    shell: true,
  });
  const endedAt = new Date().toISOString();
  const lines = [
    `BUILD_VERIFY_START ${startedAt}`,
    `SCRATCH=${GOAL_SCRATCH}`,
    '',
    result.stdout?.trimEnd() || '',
    result.stderr?.trimEnd() || '',
    '',
    `BUILD_EXIT_CODE=${result.status ?? 1}`,
    `BUILD_VERIFY_END ${endedAt}`,
  ];
  await fs.writeFile(LOG, lines.join('\n') + '\n');
  process.exit(result.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});