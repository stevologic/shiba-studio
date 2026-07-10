#!/usr/bin/env node
// `npx shiba-studio` launcher: builds once if needed, then serves on
// 127.0.0.1 (the app's security model expects loopback-only binding).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '3000';
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

if (!existsSync(nextBin)) {
  console.error('[shiba-studio] dependencies missing — run `npm install` in', root);
  process.exit(1);
}

if (!existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.log('[shiba-studio] first run — building the production bundle (one time)…');
  const build = spawnSync(process.execPath, [nextBin, 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

console.log(`[shiba-studio] starting on http://127.0.0.1:${port}`);
const start = spawnSync(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', port], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(start.status ?? 0);
