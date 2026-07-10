import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
const PORT = 34567;
const ROOT = process.cwd();
const LOG = path.join(SCRATCH, 'oauth-launch.log');

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok || res.status === 404) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Server not ready at ${url} within ${timeoutMs}ms`);
}

function killProcess(child: ChildProcess) {
  if (!child.killed && child.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { shell: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  const lines: string[] = [`launch test ${new Date().toISOString()}`, `PORT=${PORT}`];

  const dataDir = path.join(ROOT, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'xai-oauth.json'), JSON.stringify({
    accessToken: 'launch-fixture-access',
    refreshToken: 'launch-fixture-refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    email: 'launch@example.com',
    displayName: 'Launch Fixture',
    connectedAt: new Date().toISOString(),
    oidcClientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  }, null, 2));

  const configPath = path.join(dataDir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    /* fresh */
  }
  config.cloudAuthMode = 'oauth';
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const child = spawn('npm', ['run', 'start'], {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d) => lines.push(`stdout: ${String(d).trim()}`));
  child.stderr?.on('data', (d) => lines.push(`stderr: ${String(d).trim()}`));

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/config`);

    for (let i = 1; i <= 2; i++) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, { signal: AbortSignal.timeout(15_000) });
      const json = await res.json();
      lines.push(`run${i} status=${res.status}`);
      lines.push(`run${i} body=${JSON.stringify({
        hasOAuth: json.hasOAuth,
        hasCloudAuth: json.hasCloudAuth,
        hasKey: json.hasKey,
        cloudAuthMode: json.cloudAuthMode,
        activeCloudSource: json.activeCloudSource,
      })}`);
      if (!json.hasOAuth) throw new Error(`run${i}: expected hasOAuth true`);
      if (!json.hasCloudAuth) throw new Error(`run${i}: expected hasCloudAuth true`);
      if (json.activeCloudSource !== 'oauth') throw new Error(`run${i}: expected activeCloudSource oauth`);
    }

    lines.push('ok: launched server and GET /api/config twice with consistent oauth flags');
  } catch (e: unknown) {
    lines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    await fs.writeFile(path.join(SCRATCH, 'oauth-launch-fallback.log'), lines.join('\n'));
    throw e;
  } finally {
    killProcess(child);
    await fs.writeFile(LOG, lines.join('\n'));
  }

  console.log(lines.join('\n'));
  console.log(`wrote ${LOG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});