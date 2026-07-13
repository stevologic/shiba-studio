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
const SANDBOX_OWNER_LABEL = 'shiba.sandbox';
const SANDBOX_OWNER_VALUE = '1';
const SANDBOX_AGENT_LABEL = 'shiba.agent';
const DEFAULT_EXEC_TIMEOUT_SEC = 60;
const MAX_EXEC_TIMEOUT_SEC = 300;
const OUTPUT_CAP = 200_000; // bytes kept from a single exec before clipping

// Resource guardrails — configurable in Settings → Cost & safety guardrails.
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_CPUS = 1;

export interface SandboxLimits { memoryMb: number; cpus: number }

export function clampSandboxMemoryMb(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(16384, Math.max(128, n)) : DEFAULT_MEMORY_MB;
}

export function clampSandboxCpus(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(16, Math.max(0.25, Math.round(n * 100) / 100)) : DEFAULT_CPUS;
}

/** Effective limits from config (falls back to defaults if config is unreadable). */
export async function sandboxLimits(): Promise<SandboxLimits> {
  try {
    const { loadConfig } = await import('./persistence');
    const cfg = await loadConfig();
    return { memoryMb: clampSandboxMemoryMb(cfg.sandboxMemoryMb), cpus: clampSandboxCpus(cfg.sandboxCpus) };
  } catch {
    return { memoryMb: DEFAULT_MEMORY_MB, cpus: DEFAULT_CPUS };
  }
}

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

interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type DockerRunner = (
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
) => Promise<DockerResult>;

// Narrow deterministic seam for the standalone verifier. Production callers
// never set this; it lets destructive ownership checks run without Docker.
let dockerRunnerForTests: DockerRunner | null = null;

export function __setSandboxDockerRunnerForTests(runner: DockerRunner | null): void {
  dockerRunnerForTests = runner;
  dockerProbe = null;
}

/** Run the docker CLI. Never throws — failures come back as { code, stderr }. */
function docker(
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<DockerResult> {
  if (dockerRunnerForTests) return dockerRunnerForTests(args, opts);
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

type DockerLabels = Record<string, string>;

interface DockerContainerInspect {
  Id?: string;
  Name?: string;
  State?: { Running?: boolean };
  Config?: { Image?: string; Labels?: DockerLabels | null };
  HostConfig?: { Memory?: number; NanoCpus?: number };
}

function parseInspectRecord<T>(stdout: string): T | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    return record && typeof record === 'object' ? record as T : null;
  } catch {
    return null;
  }
}

function isMissingDockerObject(result: Pick<DockerResult, 'stderr'>): boolean {
  return /no such (?:object|container|volume|network)|not found/i.test(result.stderr);
}

function hasSandboxOwnership(labels: DockerLabels | null | undefined, agentId?: string): boolean {
  if (labels?.[SANDBOX_OWNER_LABEL] !== SANDBOX_OWNER_VALUE) return false;
  return agentId === undefined || labels[SANDBOX_AGENT_LABEL] === agentId;
}

async function inspectContainer(reference: string): Promise<{
  result: DockerResult;
  record: DockerContainerInspect | null;
}> {
  const result = await docker(['inspect', reference], { timeoutMs: 10_000 });
  return {
    result,
    record: result.code === 0 ? parseInspectRecord<DockerContainerInspect>(result.stdout) : null,
  };
}

/* ── Container lifecycle ──────────────────────────────────────────────── */

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; agent ids are uuids, but sanitize anyway. */
export function sandboxContainerName(agentId: string): string {
  const safe = String(agentId || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 52) || 'unknown';
  return `${SANDBOX_PREFIX}${safe}`;
}

/**
 * Make sure the agent's container exists and is running. Creates it on first
 * use (pulls the Alpine image if needed — hence the generous timeout) and
 * restarts it if it was stopped (e.g. after a Docker/host restart). Existing
 * containers are reconciled to the configured resource limits via
 * `docker update`, so a Settings change applies on next use without losing
 * the agent's state.
 */
export async function ensureSandbox(agentId: string): Promise<{ ok: boolean; created?: boolean; error?: string }> {
  const probe = await detectDocker();
  if (!probe.available) return { ok: false, error: DOCKER_MISSING_MSG };

  const name = sandboxContainerName(agentId);
  const inspected = await inspectContainer(name);
  if (inspected.result.code === 0) {
    const existing = inspected.record;
    if (!existing) {
      return { ok: false, error: 'Docker returned invalid sandbox inspection data; retry later.' };
    }
    if (!hasSandboxOwnership(existing.Config?.Labels, agentId)) {
      return {
        ok: false,
        error: `Refusing to use container ${name}: its ownership labels do not match agent ${agentId}.`,
      };
    }

    const limits = await sandboxLimits();
    const memArgs = ['--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb * 2}m`, '--cpus', String(limits.cpus)];
    if (
      Number(existing.HostConfig?.Memory) !== limits.memoryMb * 1024 * 1024
      || Number(existing.HostConfig?.NanoCpus) !== Math.round(limits.cpus * 1e9)
    ) {
      await docker(['update', ...memArgs, existing.Id || name], { timeoutMs: 20_000 });
    }
    if (!existing.State?.Running) {
      const start = await docker(['start', existing.Id || name], { timeoutMs: 30_000 });
      if (start.code !== 0) {
        return { ok: false, error: `Failed to start sandbox container: ${start.stderr.trim() || 'unknown error'}` };
      }
    }
    const workdir = await docker(['exec', existing.Id || name, 'mkdir', '-p', SANDBOX_WORKDIR], { timeoutMs: 15_000 });
    return workdir.code === 0
      ? { ok: true }
      : { ok: false, error: `Failed to prepare sandbox work directory: ${workdir.stderr.trim() || 'unknown error'}` };
  }
  if (!isMissingDockerObject(inspected.result)) {
    return {
      ok: false,
      error: `Failed to inspect sandbox container: ${inspected.result.stderr.trim() || 'unknown error'}`,
    };
  }

  const limits = await sandboxLimits();
  // Swap is pinned to 2× memory so raising the memory limit via `docker
  // update` never trips the "memory > memoryswap" rejection.
  const memArgs = ['--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb * 2}m`, '--cpus', String(limits.cpus)];

  const run = await docker(
    [
      'run', '-d',
      '--name', name,
      '--hostname', 'sandbox',
      '--label', `${SANDBOX_OWNER_LABEL}=${SANDBOX_OWNER_VALUE}`,
      '--label', `${SANDBOX_AGENT_LABEL}=${agentId}`,
      // Runaway protection — an agent experiment can't starve the host.
      ...memArgs,
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
  const workdir = await docker(['exec', name, 'mkdir', '-p', SANDBOX_WORKDIR], { timeoutMs: 15_000 });
  return workdir.code === 0
    ? { ok: true, created: true }
    : {
        ok: false,
        created: true,
        error: `Sandbox was created but its work directory could not be prepared: ${workdir.stderr.trim() || 'unknown error'}`,
      };
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
  const inspected = await inspectContainer(name);
  if (inspected.result.code !== 0) {
    return isMissingDockerObject(inspected.result)
      ? { available: true, exists: false, running: false, name }
      : {
          available: true,
          exists: false,
          running: false,
          name,
          error: inspected.result.stderr.trim() || 'Failed to inspect sandbox container',
        };
  }
  const record = inspected.record;
  if (!record) {
    return { available: true, exists: false, running: false, name, error: 'Docker returned invalid inspection data' };
  }
  if (!hasSandboxOwnership(record.Config?.Labels, agentId)) {
    return {
      available: true,
      exists: false,
      running: false,
      name,
      error: 'A container with this name exists but is not owned by this agent',
    };
  }
  return {
    available: true,
    exists: true,
    running: record.State?.Running === true,
    name,
    image: record.Config?.Image,
  };
}

export interface SandboxRemovalResult {
  ok: boolean;
  removed: boolean;
  retryable?: boolean;
  ownershipConflict?: boolean;
  error?: string;
}

/** Remove an agent's exactly-labelled container. Never deletes by name alone. */
export async function removeSandbox(agentId: string): Promise<SandboxRemovalResult> {
  const probe = await detectDocker();
  if (!probe.available) {
    return { ok: false, removed: false, retryable: true, error: DOCKER_MISSING_MSG };
  }

  const name = sandboxContainerName(agentId);
  const inspected = await inspectContainer(name);
  if (inspected.result.code !== 0) {
    if (isMissingDockerObject(inspected.result)) return { ok: true, removed: false };
    return {
      ok: false,
      removed: false,
      retryable: true,
      error: inspected.result.stderr.trim() || 'Failed to inspect sandbox container',
    };
  }
  const record = inspected.record;
  if (!record) {
    return { ok: false, removed: false, retryable: true, error: 'Docker returned invalid inspection data' };
  }
  if (!hasSandboxOwnership(record.Config?.Labels, agentId)) {
    return {
      ok: false,
      removed: false,
      ownershipConflict: true,
      error: `Refusing to remove ${name}: its ownership labels do not match agent ${agentId}.`,
    };
  }

  const removed = await docker(['container', 'rm', '-f', record.Id || name], { timeoutMs: 30_000 });
  if (removed.code === 0) return { ok: true, removed: true };
  if (isMissingDockerObject(removed)) return { ok: true, removed: false };
  return {
    ok: false,
    removed: false,
    retryable: true,
    error: removed.stderr.trim() || 'Failed to remove sandbox container',
  };
}

export type SandboxResourceKind = 'container' | 'network' | 'volume';
export type SandboxReconciliationAction = 'kept' | 'removed' | 'ignored' | 'retry_pending';

export interface SandboxReconciliationItem {
  kind: SandboxResourceKind;
  id: string;
  name?: string;
  agentId?: string;
  action: SandboxReconciliationAction;
  reason?: string;
  error?: string;
}

export interface SandboxReconciliationReport {
  status: 'ok' | 'retry_pending';
  dockerAvailable: boolean;
  retryable: boolean;
  scanned: number;
  owned: number;
  kept: number;
  removed: number;
  ignored: number;
  retryPending: number;
  items: SandboxReconciliationItem[];
  errors: string[];
}

interface DockerResourceInspect {
  Id?: string;
  Name?: string;
  Labels?: DockerLabels | null;
  Config?: { Labels?: DockerLabels | null };
}

interface SandboxResourceSpec {
  kind: SandboxResourceKind;
  listArgs: string[];
  inspectArgs: (id: string) => string[];
  removeArgs: (id: string) => string[];
  labels: (record: DockerResourceInspect) => DockerLabels | null | undefined;
}

const SANDBOX_RESOURCE_SPECS: readonly SandboxResourceSpec[] = [
  {
    kind: 'container',
    listArgs: ['container', 'ls', '-aq', '--filter', `label=${SANDBOX_OWNER_LABEL}=${SANDBOX_OWNER_VALUE}`],
    inspectArgs: (id) => ['container', 'inspect', id],
    removeArgs: (id) => ['container', 'rm', '-f', id],
    labels: (record) => record.Config?.Labels,
  },
  {
    kind: 'network',
    listArgs: ['network', 'ls', '-q', '--filter', `label=${SANDBOX_OWNER_LABEL}=${SANDBOX_OWNER_VALUE}`],
    inspectArgs: (id) => ['network', 'inspect', id],
    removeArgs: (id) => ['network', 'rm', id],
    labels: (record) => record.Labels,
  },
  {
    kind: 'volume',
    listArgs: ['volume', 'ls', '-q', '--filter', `label=${SANDBOX_OWNER_LABEL}=${SANDBOX_OWNER_VALUE}`],
    inspectArgs: (id) => ['volume', 'inspect', id],
    removeArgs: (id) => ['volume', 'rm', id],
    labels: (record) => record.Labels,
  },
] as const;

/**
 * Remove Docker resources left behind by deleted agents or interrupted
 * deletion. Inventory and deletion are label-gated; a matching name or prefix
 * is never sufficient. Failures remain visible as retryable work so the
 * periodic integrity pass can safely run this again.
 */
export async function reconcileOrphanedSandboxResources(
  validAgentIds: Iterable<string>,
): Promise<SandboxReconciliationReport> {
  const validAgents = new Set(Array.from(validAgentIds, (id) => String(id)));
  const report: SandboxReconciliationReport = {
    status: 'ok',
    dockerAvailable: true,
    retryable: false,
    scanned: 0,
    owned: 0,
    kept: 0,
    removed: 0,
    ignored: 0,
    retryPending: 0,
    items: [],
    errors: [],
  };

  const probe = await detectDocker();
  if (!probe.available) {
    return {
      ...report,
      status: 'retry_pending',
      dockerAvailable: false,
      retryable: true,
      retryPending: 1,
      errors: [DOCKER_MISSING_MSG],
    };
  }

  for (const spec of SANDBOX_RESOURCE_SPECS) {
    const listed = await docker(spec.listArgs, { timeoutMs: 30_000 });
    if (listed.code !== 0) {
      const error = `${spec.kind} inventory failed: ${listed.stderr.trim() || 'unknown Docker error'}`;
      report.retryPending += 1;
      report.errors.push(error);
      report.items.push({ kind: spec.kind, id: '', action: 'retry_pending', error });
      continue;
    }

    const ids = Array.from(new Set(
      listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean),
    ));
    for (const id of ids) {
      report.scanned += 1;
      const inspected = await docker(spec.inspectArgs(id), { timeoutMs: 15_000 });
      if (inspected.code !== 0) {
        // Another reconciler or a human may have removed it after inventory.
        if (isMissingDockerObject(inspected)) continue;
        const error = inspected.stderr.trim() || 'Docker inspection failed';
        report.retryPending += 1;
        report.errors.push(`${spec.kind} ${id}: ${error}`);
        report.items.push({ kind: spec.kind, id, action: 'retry_pending', error });
        continue;
      }

      const record = parseInspectRecord<DockerResourceInspect>(inspected.stdout);
      if (!record) {
        const error = 'Docker returned invalid inspection data';
        report.retryPending += 1;
        report.errors.push(`${spec.kind} ${id}: ${error}`);
        report.items.push({ kind: spec.kind, id, action: 'retry_pending', error });
        continue;
      }

      const labels = spec.labels(record);
      const name = record.Name?.replace(/^\//, '') || undefined;
      if (!hasSandboxOwnership(labels)) {
        report.ignored += 1;
        report.items.push({
          kind: spec.kind,
          id,
          name,
          action: 'ignored',
          reason: 'ownership_label_mismatch',
        });
        continue;
      }

      report.owned += 1;
      const agentId = labels?.[SANDBOX_AGENT_LABEL];
      if (agentId && validAgents.has(agentId)) {
        report.kept += 1;
        report.items.push({ kind: spec.kind, id, name, agentId, action: 'kept' });
        continue;
      }

      const removed = await docker(spec.removeArgs(record.Id || record.Name || id), { timeoutMs: 30_000 });
      if (removed.code === 0 || isMissingDockerObject(removed)) {
        report.removed += 1;
        report.items.push({
          kind: spec.kind,
          id,
          name,
          agentId,
          action: 'removed',
          reason: agentId ? 'agent_deleted' : 'missing_agent_label',
        });
        continue;
      }

      const error = removed.stderr.trim() || 'Docker removal failed';
      report.retryPending += 1;
      report.errors.push(`${spec.kind} ${id}: ${error}`);
      report.items.push({
        kind: spec.kind,
        id,
        name,
        agentId,
        action: 'retry_pending',
        reason: agentId ? 'agent_deleted' : 'missing_agent_label',
        error,
      });
    }
  }

  if (report.retryPending > 0) {
    report.status = 'retry_pending';
    report.retryable = true;
  }
  return report;
}
