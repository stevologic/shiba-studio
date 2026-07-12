// Per-agent Alpine Linux sandbox containers. Every agent gets its OWN
// persistent container (named shiba-sandbox-<agentId>) it can use to solve
// problems: install packages with apk, run any language, try risky commands —
// all fully isolated from the host filesystem. State persists in the container
// (working dir /work) across commands and across runs, so an agent can set up
// tools once and reuse them. Containers are created lazily on first use and
// removed when the agent is deleted.
//
// Dependency-free: drives the `docker` CLI directly (same approach as the
// mDNS responder). If Docker isn't installed or running, every call returns a
// friendly error instead of throwing.

import { execFile } from 'child_process';

const SANDBOX_IMAGE = process.env.SHIBA_SANDBOX_IMAGE || 'alpine:3.22';
const SANDBOX_PREFIX = 'shiba-sandbox-';
const SANDBOX_WORKDIR = '/work';
const DEFAULT_EXEC_TIMEOUT_SEC = 60;
const MAX_EXEC_TIMEOUT_SEC = 300;
const OUTPUT_CAP = 200_000; // bytes kept from a single exec before clipping

export interface SandboxExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
  error?: string;
}

export interface SandboxStatus {
  available: boolean;
  exists: boolean;
  running: boolean;
  name: string;
  image?: string;
  error?: string;
}

/** Run the docker CLI. Never throws — failures come back as { code, stderr }. */
function docker(
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        const code = err ? ((err as { code?: number | string }).code as number | null) ?? 1 : 0;
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: String(stdout || '').slice(0, OUTPUT_CAP),
          stderr: String(stderr || '').slice(0, OUTPUT_CAP / 4),
          timedOut,
        });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/* ── Docker availability (cached probe) ───────────────────────────────── */

let dockerProbe: { at: number; available: boolean; version?: string } | null = null;

export async function detectDocker(): Promise<{ available: boolean; version?: string }> {
  if (dockerProbe && Date.now() - dockerProbe.at < 60_000) return dockerProbe;
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  dockerProbe = {
    at: Date.now(),
    available: r.code === 0 && !!r.stdout.trim(),
    version: r.stdout.trim() || undefined,
  };
  return dockerProbe;
}

const DOCKER_MISSING_MSG =
  'Docker is not available on this machine (install/start Docker Desktop to give agents their sandbox containers).';

/* ── Container lifecycle ──────────────────────────────────────────────── */

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; agent ids are uuids, but sanitize anyway. */
export function sandboxContainerName(agentId: string): string {
  const safe = String(agentId || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 52) || 'unknown';
  return `${SANDBOX_PREFIX}${safe}`;
}

/**
 * Make sure the agent's container exists and is running. Creates it on first
 * use (pulls the Alpine image if needed — hence the generous timeout) and
 * restarts it if it was stopped (e.g. after a Docker/host restart).
 */
export async function ensureSandbox(agentId: string): Promise<{ ok: boolean; created?: boolean; error?: string }> {
  const probe = await detectDocker();
  if (!probe.available) return { ok: false, error: DOCKER_MISSING_MSG };

  const name = sandboxContainerName(agentId);
  const inspect = await docker(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
  if (inspect.code === 0) {
    if (inspect.stdout.trim() === 'true') return { ok: true };
    const start = await docker(['start', name], { timeoutMs: 30_000 });
    return start.code === 0
      ? { ok: true }
      : { ok: false, error: `Failed to start sandbox container: ${start.stderr.trim() || 'unknown error'}` };
  }

  const run = await docker(
    [
      'run', '-d',
      '--name', name,
      '--hostname', 'sandbox',
      '--label', 'shiba.sandbox=1',
      '--label', `shiba.agent=${agentId}`,
      // Runaway protection — an agent experiment can't starve the host.
      '--memory', '512m',
      '--cpus', '1',
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      SANDBOX_IMAGE,
      'sleep', 'infinity',
    ],
    { timeoutMs: 180_000 }, // first run may pull the image
  );
  if (run.code !== 0) {
    return { ok: false, error: `Failed to create sandbox container: ${run.stderr.trim() || 'unknown error'}` };
  }
  await docker(['exec', name, 'mkdir', '-p', SANDBOX_WORKDIR], { timeoutMs: 15_000 });
  return { ok: true, created: true };
}

/**
 * Run a shell command inside the agent's container (cwd /work). The timeout is
 * enforced INSIDE the container (busybox `timeout`), so a hung command dies in
 * the sandbox instead of surviving a client-side kill.
 */
export async function sandboxExec(
  agentId: string,
  command: string,
  timeoutSec?: number,
): Promise<SandboxExecResult> {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, stdout: '', stderr: '', code: null, error: 'command is required' };

  const ensured = await ensureSandbox(agentId);
  if (!ensured.ok) return { ok: false, stdout: '', stderr: '', code: null, error: ensured.error };

  const secs = Math.min(MAX_EXEC_TIMEOUT_SEC, Math.max(1, Math.floor(timeoutSec || DEFAULT_EXEC_TIMEOUT_SEC)));
  const name = sandboxContainerName(agentId);
  const r = await docker(
    ['exec', '-w', SANDBOX_WORKDIR, name, 'timeout', String(secs), 'sh', '-lc', cmd],
    { timeoutMs: (secs + 15) * 1000 },
  );
  // busybox timeout exits 143 (SIGTERM) / 124 when the deadline fires.
  const timedOut = r.timedOut || r.code === 143 || r.code === 124;
  return {
    ok: r.code === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    code: r.code,
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/** Write a file into the agent's container (relative paths land in /work). */
export async function sandboxWriteFile(
  agentId: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }> {
  const rel = String(filePath || '').trim();
  if (!rel) return { ok: false, error: 'path is required' };
  const abs = rel.startsWith('/') ? rel : `${SANDBOX_WORKDIR}/${rel}`;

  const ensured = await ensureSandbox(agentId);
  if (!ensured.ok) return { ok: false, error: ensured.error };

  const name = sandboxContainerName(agentId);
  const body = String(content ?? '');
  // $0 = the target path; content arrives over stdin so no shell-quoting games.
  const r = await docker(
    ['exec', '-i', name, 'sh', '-c', 'mkdir -p "$(dirname "$0")" && cat > "$0"', abs],
    { timeoutMs: 30_000, input: body },
  );
  return r.code === 0
    ? { ok: true, path: abs, bytes: Buffer.byteLength(body) }
    : { ok: false, error: r.stderr.trim() || 'write failed' };
}

export async function sandboxStatus(agentId: string): Promise<SandboxStatus> {
  const name = sandboxContainerName(agentId);
  const probe = await detectDocker();
  if (!probe.available) {
    return { available: false, exists: false, running: false, name, error: DOCKER_MISSING_MSG };
  }
  const r = await docker(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', name], { timeoutMs: 10_000 });
  if (r.code !== 0) return { available: true, exists: false, running: false, name };
  const [running, image] = r.stdout.trim().split(/\s+/);
  return { available: true, exists: true, running: running === 'true', name, image };
}

/** Remove the agent's container (used when the agent is deleted). Best-effort. */
export async function removeSandbox(agentId: string): Promise<{ ok: boolean; removed: boolean }> {
  const probe = await detectDocker();
  if (!probe.available) return { ok: false, removed: false };
  const r = await docker(['rm', '-f', sandboxContainerName(agentId)], { timeoutMs: 30_000 });
  return { ok: true, removed: r.code === 0 };
}
