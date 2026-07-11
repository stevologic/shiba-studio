#!/usr/bin/env node
// Cross-platform LAN launch: sets SHIBA_LAN=1 (so the mDNS responder advertises
// the machine's LAN IP for shiba.local / shib.local) and runs Next bound to 0.0.0.0.
//   node scripts/lan.mjs dev    → npm run dev:lan
//   node scripts/lan.mjs start  → npm run start:lan
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

const child = spawn(process.execPath, [nextBin, mode, '-H', '0.0.0.0'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SHIBA_LAN: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
