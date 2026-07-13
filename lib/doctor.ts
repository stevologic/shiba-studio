import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from './data-paths';
import { getDb } from './db';
import { loadAgents, loadConfig, saveConfig } from './persistence';

export type DoctorStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  id: string;
  category: 'models' | 'auth' | 'mcp' | 'browser' | 'tasks' | 'storage' | 'runtime' | 'network' | 'extensions';
  label: string;
  status: DoctorStatus;
  detail: string;
  data?: Record<string, string | number | boolean | null>;
  repairAction?: DoctorRepairAction;
}

export type DoctorRepairAction =
  | 'reconcile_interrupted_work'
  | 'resync_scheduler'
  | 'requeue_stale_delivery'
  | 'enable_safe_mode'
  | 'disable_safe_mode';

export interface DoctorReport {
  generatedAt: string;
  safeMode: boolean;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

const REPAIR_DESCRIPTIONS: Record<DoctorRepairAction, string> = {
  reconcile_interrupted_work: 'Mark orphaned running tasks and agent runs as interrupted/lost. No files are changed.',
  resync_scheduler: 'Stop and re-arm configured schedules from the current agent records.',
  requeue_stale_delivery: 'Return expired task outbox delivery leases to the retry queue.',
  enable_safe_mode: 'Disable optional listeners and extension packs on the next server start while preserving all data.',
  disable_safe_mode: 'Re-enable normal startup of optional listeners and extension packs on the next server start.',
};

const execFileAsync = promisify(execFile);

async function resolveExecutable(command: string): Promise<boolean> {
  const value = command.trim();
  if (!value || /[\r\n\0]/.test(value)) return false;
  const hasPath = path.isAbsolute(value) || value.includes('/') || value.includes('\\');
  const extensions = process.platform === 'win32'
    ? uniqueStrings(['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')])
    : [''];
  const candidates = hasPath
    ? extensions.map((extension) => value.toLowerCase().endsWith(extension.toLowerCase()) ? value : `${value}${extension}`)
    : (process.env.PATH || '').split(path.delimiter).flatMap((directory) => extensions.map((extension) => path.join(directory, `${value}${extension}`)));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return true;
  }
  return false;
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function check(
  id: string,
  category: DoctorCheck['category'],
  label: string,
  status: DoctorStatus,
  detail: string,
  extra: Pick<DoctorCheck, 'data' | 'repairAction'> = {},
): DoctorCheck {
  return { id, category, label, status, detail, ...extra };
}

async function modelChecks(): Promise<DoctorCheck[]> {
  const cfg = await loadConfig();
  const result: DoctorCheck[] = [];
  const { resolveCloudBearer, getOAuthPublicStatus } = await import('./xai-oauth');
  const [auth, oauth] = await Promise.all([resolveCloudBearer(cfg), getOAuthPublicStatus()]);
  result.push(check(
    'cloud-auth', 'auth', 'xAI credentials', auth.hasCloudAuth ? 'ok' : 'warning',
    auth.hasCloudAuth ? `Cloud authentication is available through ${auth.source || 'a configured source'}.` : 'No xAI cloud credential is currently usable.',
    { data: { source: auth.source || null, oauthConnected: oauth.connected } },
  ));
  const { cloudReachable } = await import('./run-guards');
  const reach = await cloudReachable();
  result.push(check(
    'cloud-reachability', 'models', 'xAI model endpoint', reach.ok ? 'ok' : 'warning',
    reach.ok ? 'api.x.ai is reachable.' : 'api.x.ai is not reachable from this host.',
  ));
  if (cfg.localGrokEnabled) {
    const { listLocalGrokModels } = await import('./grok-client');
    const local = await listLocalGrokModels(cfg.localGrokBaseUrl);
    result.push(check(
      'local-models', 'models', 'Local model runtime', local.ok ? 'ok' : 'error',
      local.ok ? `${local.models.length} local model${local.models.length === 1 ? '' : 's'} discovered.` : (local.error || 'Local runtime probe failed.'),
      { data: { models: local.models.length } },
    ));
  } else {
    result.push(check('local-models', 'models', 'Local model runtime', 'ok', 'Local model support is disabled by configuration.'));
  }
  const { isGoogleClientReady } = await import('./google-oauth');
  const googleReady = await isGoogleClientReady();
  result.push(check(
    'google-oauth', 'auth', 'Google OAuth client', googleReady ? 'ok' : 'warning',
    googleReady ? 'Google OAuth callback configuration is available.' : 'Google OAuth client configuration is missing.',
  ));
  return result;
}

async function capabilityChecks(): Promise<DoctorCheck[]> {
  const result: DoctorCheck[] = [];
  const { listMcpServersReadOnly } = await import('./mcp');
  const { getMcpPreset } = await import('./mcp-catalog');
  const servers = await listMcpServersReadOnly();
  const enabled = servers.filter((server) => server.enabled);
  const launchProblems: string[] = [];
  for (const server of enabled) {
    if (!await resolveExecutable(server.command)) launchProblems.push(`${server.name}: command is unavailable`);
    const preset = server.presetId ? getMcpPreset(server.presetId) : undefined;
    if (server.presetId && !preset) launchProblems.push(`${server.name}: preset is no longer supported`);
    if (preset) {
      const missing = preset.envFields.filter((field) => field.required && !field.asArg && !server.env[field.key]);
      if (missing.length) launchProblems.push(`${server.name}: ${missing.length} required environment field${missing.length === 1 ? '' : 's'} missing`);
      const requiredArgs = preset.envFields.filter((field) => field.required && field.asArg).length;
      if (server.args.length < preset.args.length + requiredArgs) launchProblems.push(`${server.name}: required bounded path argument is missing`);
    }
  }
  result.push(check(
    'mcp-launch-readiness', 'mcp', 'MCP launch and tool-discovery readiness', launchProblems.length ? 'warning' : 'ok',
    launchProblems.length
      ? `${launchProblems.length} static launch-readiness problem${launchProblems.length === 1 ? '' : 's'} found. Doctor does not start arbitrary configured commands; use each server's explicit Test action for process startup and tool discovery.`
      : `${enabled.length} of ${servers.length} configured MCP server${servers.length === 1 ? '' : 's'} enabled with resolvable commands and required fields. Doctor does not start arbitrary configured commands; use the explicit Test action for process startup and tool discovery.`,
    { data: { configured: servers.length, enabled: enabled.length, launchProblems: launchProblems.length, processStarted: false } },
  ));
  try {
    const puppeteer = await import('puppeteer');
    const executable = await puppeteer.default.executablePath();
    const exists = !!executable && await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false);
    let healthy = false;
    let healthError = '';
    if (exists) {
      let browser: Awaited<ReturnType<typeof puppeteer.default.launch>> | undefined;
      try {
        browser = await puppeteer.default.launch({ headless: true, timeout: 15_000 });
        const page = await browser.newPage();
        await page.goto('about:blank', { waitUntil: 'load', timeout: 5_000 });
        healthy = await page.evaluate(() => 6 * 7) === 42;
      } catch (error) {
        healthError = error instanceof Error ? error.message.slice(0, 240) : 'Chromium launch failed';
      } finally {
        await browser?.close().catch(() => {});
      }
    }
    result.push(check(
      'browser-runtime', 'browser', 'Chromium automation runtime', healthy ? 'ok' : 'warning',
      healthy ? 'Puppeteer launched an isolated headless page and completed a script health check.' : (healthError || 'Chromium was not found; browser tools will explain how to install it.'),
      { data: { installed: exists, launchHealthy: healthy } },
    ));
  } catch (error) {
    result.push(check('browser-runtime', 'browser', 'Chromium automation runtime', 'warning', error instanceof Error ? error.message.slice(0, 300) : 'Browser runtime probe failed.'));
  }
  return result;
}

async function hostBoundaryChecks(): Promise<DoctorCheck[]> {
  const result: DoctorCheck[] = [];
  const cfg = await loadConfig();
  const agents = await loadAgents();
  const workspaceAgents = new Map<string, string[]>();
  for (const agent of agents.filter((item) => item.workspace?.useWorktree && item.workspace?.path)) {
    const workspace = path.resolve(agent.workspace.path);
    workspaceAgents.set(workspace, [...(workspaceAgents.get(workspace) || []), agent.id]);
  }
  if (cfg.defaultWorkspace) workspaceAgents.set(path.resolve(cfg.defaultWorkspace), workspaceAgents.get(path.resolve(cfg.defaultWorkspace)) || []);
  let orphaned = 0;
  let missingRoots = 0;
  let gitRepos = 0;
  let missingOrigins = 0;
  let credentialOrigins = 0;
  const { listWorktrees } = await import('./workspace');
  for (const [workspace, agentIds] of workspaceAgents) {
    if (!await fs.stat(workspace).then((stat) => stat.isDirectory()).catch(() => false)) { missingRoots++; continue; }
    try {
      const listed = await listWorktrees(workspace, agentIds);
      if (!listed.isGitRepo) continue;
      gitRepos++;
      const known = new Set(agentIds);
      orphaned += listed.worktrees.filter((entry) => entry.exists && !known.has(entry.agentId)).length;
      try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: workspace, timeout: 5_000, windowsHide: true });
        const remote = stdout.trim();
        if (!remote) missingOrigins++;
        else {
          try { const parsed = new URL(remote); if (parsed.username || parsed.password) credentialOrigins++; }
          catch { if (!/^[^@\s]+@[^:\s]+:.+/.test(remote)) missingOrigins++; }
        }
      } catch { missingOrigins++; }
    } catch { missingRoots++; }
  }
  result.push(check(
    'worktree-health', 'runtime', 'Workspace worktrees and Git origins', orphaned || missingRoots || credentialOrigins ? 'warning' : 'ok',
    `${gitRepos} Git workspace${gitRepos === 1 ? '' : 's'} inspected; ${orphaned} orphaned worktree${orphaned === 1 ? '' : 's'}, ${missingRoots} missing workspace root${missingRoots === 1 ? '' : 's'}, ${missingOrigins} missing origin${missingOrigins === 1 ? '' : 's'}, and ${credentialOrigins} origin URL${credentialOrigins === 1 ? '' : 's'} containing embedded credentials.`,
    { data: { workspaces: workspaceAgents.size, gitRepos, orphaned, missingRoots, missingOrigins, credentialOrigins } },
  ));

  const lan = process.env.SHIBA_LAN === '1';
  const proxyReady = !!process.env.SHIBA_LAN_PROXY_SECRET && !!process.env.SHIBA_INTERNAL_PORT && !!process.env.SHIBA_APP_PORT;
  result.push(check(
    'origin-firewall-boundary', 'network', 'Origin and LAN application firewall', lan && !proxyReady ? 'error' : 'ok',
    lan
      ? (proxyReady ? 'LAN mode uses a peer-classifying outer proxy, loopback-only Next server, secret internal hop, origin checks, and scoped remote routes.' : 'LAN mode is missing its trusted proxy secret or internal/public port metadata; remote classification must fail closed.')
      : 'Loopback mode is active; API origin checks and cross-site request rejection remain enabled.',
    { data: { lan, proxyReady, originGuard: true, scopedRemoteRoutes: true } },
  ));

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netsh', ['advfirewall', 'show', 'allprofiles', 'state'], { timeout: 8_000, windowsHide: true });
      const states = [...stdout.matchAll(/^\s*State\s+(ON|OFF)\s*$/gim)].map((match) => match[1].toUpperCase());
      const disabled = states.filter((state) => state === 'OFF').length;
      result.push(check('host-firewall', 'network', 'Windows Firewall profiles', disabled ? 'warning' : states.length ? 'ok' : 'warning',
        states.length ? `${states.length} firewall profile state${states.length === 1 ? '' : 's'} read; ${disabled} disabled.` : 'Windows Firewall did not return parseable profile states.',
        { data: { profiles: states.length, disabled } }));
    } catch {
      result.push(check('host-firewall', 'network', 'Windows Firewall profiles', 'warning', 'Windows Firewall state could not be read without changing host configuration.'));
    }
  } else {
    result.push(check('host-firewall', 'network', 'Host firewall', 'warning', `Host firewall inspection is not available for ${os.platform()}; no privileged command was attempted.`));
  }
  return result;
}

async function extensionChecks(): Promise<DoctorCheck[]> {
  const db = getDb();
  let incompatiblePacks = 0;
  const hasPacks = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_packs'").get();
  if (hasPacks) {
    const rows = db.prepare(`SELECT v.manifest FROM capability_packs p JOIN capability_pack_versions v
      ON v.packId = p.id AND v.version = p.activeVersion WHERE p.status = 'active'`).all() as Array<{ manifest: string }>;
    const { capabilityPackRuntimeIssues } = await import('./capability-packs');
    incompatiblePacks = rows.filter((row) => {
      try { return capabilityPackRuntimeIssues(JSON.parse(row.manifest)).length > 0; } catch { return true; }
    }).length;
  }
  let incompatibleNodes = 0;
  const hasNodes = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'native_nodes'").get();
  if (hasNodes) {
    incompatibleNodes = Number((db.prepare(`SELECT COUNT(*) AS n FROM native_nodes
      WHERE revokedAt IS NULL AND expiresAt > ? AND releaseId <> 'shiba-native-windows-1.0.0'`).get(new Date().toISOString()) as { n: number }).n);
  }
  const incompatible = incompatiblePacks + incompatibleNodes;
  return [check(
    'extension-compatibility', 'extensions', 'Pack and native-helper compatibility', incompatible ? 'error' : 'ok',
    incompatible ? `${incompatiblePacks} active pack${incompatiblePacks === 1 ? '' : 's'} and ${incompatibleNodes} native helper${incompatibleNodes === 1 ? '' : 's'} are incompatible with this runtime.` : 'Active packs use supported runtime sections and active native helpers use the current signed release protocol.',
    { data: { incompatiblePacks, incompatibleNodes } },
  )];
}

async function dataChecks(): Promise<DoctorCheck[]> {
  const result: DoctorCheck[] = [];
  const db = getDb();
  const quick = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version || 0);
  result.push(check(
    'sqlite-integrity', 'storage', 'SQLite integrity and migrations', quick.quick_check === 'ok' ? 'ok' : 'error',
    quick.quick_check === 'ok' ? `Database quick check passed at schema version ${version}.` : `SQLite quick check failed: ${quick.quick_check || 'unknown error'}`,
    { data: { schemaVersion: version } },
  ));
  const root = dataDir();
  const disk = await fs.statfs(root).catch(() => null);
  const available = disk ? Number(disk.bavail) * Number(disk.bsize) : null;
  const warning = available != null && available < 1024 * 1024 * 1024;
  result.push(check(
    'disk-space', 'storage', 'Data-disk free space', warning ? 'warning' : available == null ? 'warning' : 'ok',
    available == null ? 'Free space could not be measured.' : `${(available / 1024 / 1024 / 1024).toFixed(1)} GiB is available on the Shiba data volume.`,
    { data: { availableBytes: available } },
  ));
  const { secretKeyLocation } = await import('./secure-store');
  result.push(check('encryption-key', 'storage', 'Credential encryption key', 'ok', `Encryption key source: ${secretKeyLocation()}. Secret material is not included in this report.`));
  result.push(check('backup-freshness', 'storage', 'Backup freshness', 'warning', 'Browser-exported backups are not retained by Shiba, so their freshness cannot be verified locally. Export a current backup from Settings.'));
  return result;
}

async function runtimeChecks(): Promise<DoctorCheck[]> {
  const result: DoctorCheck[] = [];
  const db = getDb();
  const active = Number((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n: number }).n);
  const stale = Number((db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE status = 'running' AND COALESCE(heartbeatAt, updatedAt) < ?
  `).get(new Date(Date.now() - 10 * 60_000).toISOString()) as { n: number }).n);
  result.push(check(
    'task-heartbeats', 'tasks', 'Task heartbeats and lost work', stale ? 'warning' : 'ok',
    stale ? `${stale} running task${stale === 1 ? '' : 's'} have not reported activity for 10 minutes.` : `${active} running task${active === 1 ? '' : 's'}; none have a stale heartbeat.`,
    { data: { active, stale }, ...(stale ? { repairAction: 'reconcile_interrupted_work' as const } : {}) },
  ));
  const staleDeliveries = Number((db.prepare(`
    SELECT COUNT(*) AS n FROM task_outbox WHERE status = 'processing' AND availableAt <= ?
  `).get(new Date().toISOString()) as { n: number }).n);
  result.push(check(
    'task-delivery', 'tasks', 'Task completion delivery', staleDeliveries ? 'warning' : 'ok',
    staleDeliveries ? `${staleDeliveries} expired delivery lease${staleDeliveries === 1 ? '' : 's'} can be requeued.` : 'No expired task-delivery leases were found.',
    { data: { stale: staleDeliveries }, ...(staleDeliveries ? { repairAction: 'requeue_stale_delivery' as const } : {}) },
  ));
  const agents = await loadAgents();
  const expectedSchedules = agents.reduce((count, agent) => count + (agent.schedules || []).filter((entry) => entry.enabled).length, 0);
  const { listScheduled } = await import('./scheduler');
  const armed = listScheduled().length;
  result.push(check(
    'scheduler', 'runtime', 'Routine scheduler', armed === expectedSchedules ? 'ok' : 'warning',
    `${armed} schedule${armed === 1 ? '' : 's'} armed; ${expectedSchedules} enabled in agent configuration.`,
    { data: { armed, expected: expectedSchedules }, ...(armed === expectedSchedules ? {} : { repairAction: 'resync_scheduler' as const }) },
  ));
  const { getTerminalServerInfo } = await import('./terminal-server');
  const terminal = getTerminalServerInfo();
  result.push(check('terminal-bridge', 'runtime', 'Terminal bridge', terminal ? 'ok' : 'warning', terminal ? `Terminal bridge is listening on loopback port ${terminal.port}.` : 'The terminal bridge has not started.', { data: { running: !!terminal } }));
  return result;
}

export async function runDoctor(): Promise<DoctorReport> {
  const cfg = await loadConfig();
  const groups = await Promise.allSettled([modelChecks(), capabilityChecks(), dataChecks(), runtimeChecks(), hostBoundaryChecks(), extensionChecks()]);
  const checks = groups.flatMap((group, index) => group.status === 'fulfilled'
    ? group.value
    : [check(`probe-${index}`, 'runtime', 'Diagnostic probe', 'error', group.reason instanceof Error ? group.reason.message.slice(0, 400) : 'Probe failed')]);
  checks.push(check(
    'safe-mode', 'runtime', 'Safe mode', cfg.safeMode ? 'warning' : 'ok',
    cfg.safeMode ? 'Safe mode is enabled; optional listeners and extension packs stay disabled after restart.' : 'Normal startup mode is enabled.',
    { repairAction: cfg.safeMode ? 'disable_safe_mode' : 'enable_safe_mode' },
  ));
  const host = String(process.env.HOST || process.env.HOSTNAME || 'loopback/default');
  checks.push(check('network-bind', 'network', 'Network binding', host === '0.0.0.0' ? 'warning' : 'ok', host === '0.0.0.0' ? 'The server is bound to all interfaces. Use companion pairing for remote actions.' : `Server bind mode: ${host}.`, { data: { lanExposed: host === '0.0.0.0' } }));
  const summary: Record<DoctorStatus, number> = { ok: 0, warning: 0, error: 0 };
  for (const item of checks) summary[item.status]++;
  return { generatedAt: new Date().toISOString(), safeMode: !!cfg.safeMode, summary, checks };
}

export function previewDoctorRepair(action: DoctorRepairAction): { action: DoctorRepairAction; effect: string } {
  const effect = REPAIR_DESCRIPTIONS[action];
  if (!effect) throw new Error('Unknown Doctor repair action');
  return { action, effect };
}

export async function applyDoctorRepair(action: DoctorRepairAction, confirmation: string): Promise<Record<string, unknown>> {
  previewDoctorRepair(action);
  if (confirmation !== action) throw new Error(`Exact confirmation is required: ${action}`);
  let result: Record<string, unknown>;
  if (action === 'reconcile_interrupted_work') {
    const { reconcileOrphanedRuns } = await import('./agent-runs-store');
    const { reconcileOrphanedTasks } = await import('./task-ledger');
    result = { runs: reconcileOrphanedRuns(), tasks: reconcileOrphanedTasks() };
  } else if (action === 'resync_scheduler') {
    const { loadAndScheduleAll, listScheduled } = await import('./scheduler');
    await loadAndScheduleAll();
    result = { armed: listScheduled().length };
  } else if (action === 'requeue_stale_delivery') {
    const changes = getDb().prepare(`
      UPDATE task_outbox SET status = 'failed', availableAt = ?, lastError = 'Lease expired; requeued by Shiba Doctor'
      WHERE status = 'processing' AND availableAt <= ?
    `).run(new Date().toISOString(), new Date().toISOString()).changes;
    result = { requeued: Number(changes) };
  } else {
    const safeMode = action === 'enable_safe_mode';
    await saveConfig({ safeMode });
    result = { safeMode, restartRequired: true };
  }
  const { audit } = await import('./audit-log');
  audit('system', 'doctor repair applied', action, result);
  return result;
}
