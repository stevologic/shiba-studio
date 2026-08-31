/**
 * Fail if a public xAI REST family or Grok CLI harness is omitted from the
 * imported coverage list, or if image-edit / video / x_search are not wired.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import {
  assertXaiCoverageComplete,
  XAI_SURFACE_COVERAGE,
  xaiCoverageById,
} from '../lib/xai-coverage';

const LOG = path.join(SCRATCH, 'verify-xai-coverage.log');

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  const problems = assertXaiCoverageComplete();
  assert.equal(problems.length, 0, problems.join('; '));
  assert.equal(xaiCoverageById('image-edit')?.status, 'wired');
  assert.equal(xaiCoverageById('video-generation')?.status, 'wired');
  assert.equal(xaiCoverageById('x-search')?.status, 'wired');
  assert.equal(xaiCoverageById('acp-stdio')?.status, 'deferred');
  assert.equal(xaiCoverageById('collections')?.status, 'deferred');
  assert.equal(xaiCoverageById('batches')?.status, 'deferred');
  const ids = XAI_SURFACE_COVERAGE.map((e) => e.id).join(', ');
  const text = [
    `XAI_COVERAGE_VERIFY ${new Date().toISOString()}`,
    `entries=${XAI_SURFACE_COVERAGE.length}`,
    `ids=${ids}`,
    'PASS: xAI coverage list',
  ].join('\n');
  await fs.writeFile(LOG, text + '\n');
  console.log(text);
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  console.error(`FAIL: ${msg}`);
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(LOG, `FAIL: ${msg}\n`).catch(() => {});
  process.exit(1);
});
