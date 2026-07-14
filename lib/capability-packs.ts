import { createHash, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { dataDir } from './data-paths';
import { getDb } from './db';
import { looksSensitive, listMemories } from './agent-memory';
import type { SkillPreset } from './skills-catalog';
import type {
  CapabilityPackManifest,
  CapabilityPackProposal,
  CapabilityPackRecord,
  LearningJourneyEntry,
  PackCheckResult,
  PackPermission,
  PackScanFinding,
  PackSourceType,
  PackSurface,
} from './capability-pack-types';
import { quarantineManagedPath } from './managed-storage-quarantine';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_URL_BYTES = 512_000;
const MAX_FOLDER_BYTES = 1_000_000;
const MAX_FOLDER_FILES = 120;
const SURFACES = new Set<PackSurface>(['chat', 'agent', 'routine', 'companion', 'board']);

interface ProposalRow {
  id: string; packId: string; version: string; status: string; sourceType: string;
  sourceRef: string; sourceHash: string; manifest: string; diff: string; scan: string;
  tests: string; setup: string; requestedPermissionKeys: string; createdAt: string; reviewedAt: string | null;
}

interface PackRow {
  id: string; name: string; description: string; status: string; activeVersion: string | null;
  previousVersion: string | null; grantedPermissionKeys: string; sourceType: string; sourceRef: string;
  sourceHash: string; usageCount: number; lastUsedAt: string | null; lastSuccessAt: string | null;
  lastSuccessRunId: string | null; staleAt: string | null; pinned: number; archived: number;
  createdAt: string; updatedAt: string;
}

function nowIso(): string { return new Date().toISOString(); }
function staleAt(): string { return new Date(Date.now() + 90 * 86_400_000).toISOString(); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function parseJson<T>(raw: string, fallback: T): T { try { return JSON.parse(raw) as T; } catch { return fallback; } }
function clean(value: unknown, max: number, required = false): string {
  const text = String(value ?? '').trim().slice(0, max);
  if (required && !text) throw new Error('Required pack field is empty');
  return text;
}
function id(value: unknown, label = 'id'): string {
  const result = clean(value, 80, true).toLowerCase();
  if (!ID_RE.test(result)) throw new Error(`Invalid pack ${label}`);
  return result;
}
function array(value: unknown, max = 100): unknown[] { return Array.isArray(value) ? value.slice(0, max) : []; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function surfaces(value: unknown): PackSurface[] {
  return unique(array(value, 10).map(String)
    .filter((surface): surface is PackSurface => SURFACES.has(surface as PackSurface)));
}

export function ensureCapabilityPackSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS capability_pack_proposals (
      id TEXT PRIMARY KEY, packId TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
      sourceType TEXT NOT NULL, sourceRef TEXT NOT NULL, sourceHash TEXT NOT NULL,
      manifest TEXT NOT NULL, diff TEXT NOT NULL, scan TEXT NOT NULL, tests TEXT NOT NULL,
      setup TEXT NOT NULL, requestedPermissionKeys TEXT NOT NULL, createdAt TEXT NOT NULL, reviewedAt TEXT,
      UNIQUE(packId, version, sourceHash)
    );
    CREATE INDEX IF NOT EXISTS idx_pack_proposals_status ON capability_pack_proposals(status, createdAt DESC);
    CREATE TABLE IF NOT EXISTS capability_packs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      activeVersion TEXT, previousVersion TEXT, grantedPermissionKeys TEXT NOT NULL DEFAULT '[]',
      sourceType TEXT NOT NULL, sourceRef TEXT NOT NULL, sourceHash TEXT NOT NULL,
      usageCount INTEGER NOT NULL DEFAULT 0, lastUsedAt TEXT, lastSuccessAt TEXT, lastSuccessRunId TEXT,
      staleAt TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capability_packs_status ON capability_packs(status, archived, updatedAt DESC);
    CREATE TABLE IF NOT EXISTS capability_pack_versions (
      packId TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, sourceHash TEXT NOT NULL,
      approvedPermissionKeys TEXT NOT NULL, proposalId TEXT NOT NULL, createdAt TEXT NOT NULL,
      PRIMARY KEY(packId, version)
    );
  `);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function capabilityPermissionKey(permission: PackPermission): string {
  return `${permission.id}:${hash(canonical({
    action: permission.action, access: permission.access, resource: permission.resource || '',
    accountScope: permission.accountScope || '', parameters: permission.parameters || {},
    confirmation: permission.confirmation, surfaces: [...permission.surfaces].sort(),
  })).slice(0, 20)}`;
}

function normalizePermission(raw: unknown): PackPermission {
  const value = raw as Partial<PackPermission>;
  const access = ['read', 'write', 'execute', 'admin'].includes(String(value.access))
    ? value.access as PackPermission['access'] : 'read';
  const confirmation = ['never', 'once', 'each_time'].includes(String(value.confirmation))
    ? value.confirmation as PackPermission['confirmation'] : (access === 'read' ? 'never' : 'each_time');
  const supported = surfaces(value.surfaces);
  return {
    id: id(value.id, 'permission id'), action: clean(value.action, 200, true), access,
    ...(value.resource ? { resource: clean(value.resource, 500) } : {}),
    ...(value.accountScope ? { accountScope: clean(value.accountScope, 300) } : {}),
    ...(value.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters)
      ? { parameters: value.parameters } : {}),
    confirmation, surfaces: supported.length ? supported : ['agent'],
  };
}

function permissionIds(value: unknown): string[] { return unique(array(value, 50).map((item) => id(item, 'permission reference'))); }

export function normalizeCapabilityPackManifest(input: unknown): CapabilityPackManifest {
  const raw = input as Partial<CapabilityPackManifest>;
  const permissions = array(raw.permissions, 100).map(normalizePermission);
  if (new Set(permissions.map((item) => item.id)).size !== permissions.length) throw new Error('Pack permission ids must be unique');
  const permissionSet = new Set(permissions.map((item) => item.id));
  const assertRefs = (refs: string[], label: string) => {
    for (const ref of refs) if (!permissionSet.has(ref)) throw new Error(`${label} references unknown permission ${ref}`);
    return refs;
  };
  const manifest: CapabilityPackManifest = {
    schemaVersion: 1,
    id: id(raw.id, 'id'), name: clean(raw.name, 160, true),
    version: clean(raw.version, 80, true), description: clean(raw.description, 4_000),
    supportedSurfaces: surfaces(raw.supportedSurfaces),
    permissions,
    skills: array(raw.skills, 100).map((item) => {
      const value = item as CapabilityPackManifest['skills'][number];
      const category = ['coding', 'research', 'automation', 'communication', 'creative'].includes(String(value.category))
        ? value.category : 'automation';
      return { id: id(value.id, 'skill id'), name: clean(value.name, 160, true), description: clean(value.description, 1_000),
        category, promptHint: clean(value.promptHint, 12_000, true),
        permissionIds: assertRefs(permissionIds(value.permissionIds), `Skill ${value.id}`) };
    }),
    commands: array(raw.commands, 100).map((item) => {
      const value = item as CapabilityPackManifest['commands'][number];
      return { id: id(value.id, 'command id'), syntax: clean(value.syntax, 300, true), description: clean(value.description, 1_000),
        promptTemplate: clean(value.promptTemplate, 12_000, true), permissionIds: assertRefs(permissionIds(value.permissionIds), `Command ${value.id}`),
        surfaces: surfaces(value.surfaces) };
    }),
    agents: array(raw.agents, 50).map((item) => {
      const value = item as CapabilityPackManifest['agents'][number];
      return { id: id(value.id, 'agent template id'), name: clean(value.name, 160, true), description: clean(value.description, 1_000),
        model: clean(value.model, 200), skills: unique(array(value.skills, 100).map(String)),
        integrationRequirements: unique(array(value.integrationRequirements, 30).map(String)),
        permissionIds: assertRefs(permissionIds(value.permissionIds), `Agent ${value.id}`) };
    }),
    mcpServers: array(raw.mcpServers, 50).map((item) => {
      const value = item as CapabilityPackManifest['mcpServers'][number];
      return { id: id(value.id, 'MCP id'), name: clean(value.name, 160, true), presetId: clean(value.presetId, 100),
        command: clean(value.command, 500), args: array(value.args, 50).map((arg) => clean(arg, 1_000)),
        requiredEnv: unique(array(value.requiredEnv, 50).map((key) => clean(key, 100))),
        permissionIds: assertRefs(permissionIds(value.permissionIds), `MCP ${value.id}`) };
    }),
    integrationRequirements: unique(array(raw.integrationRequirements, 30).map((item) => clean(item, 100))),
    hooks: array(raw.hooks, 50).map((item) => {
      const value = item as CapabilityPackManifest['hooks'][number];
      return { id: id(value.id, 'hook id'), event: clean(value.event, 300, true), routineTemplateId: clean(value.routineTemplateId, 80),
        permissionIds: assertRefs(permissionIds(value.permissionIds), `Hook ${value.id}`) };
    }),
    routineTemplates: array(raw.routineTemplates, 50).map((item) => {
      const value = item as CapabilityPackManifest['routineTemplates'][number];
      if (!value.definition || typeof value.definition !== 'object') throw new Error('Routine template definition is required');
      return { id: id(value.id, 'routine template id'), name: clean(value.name, 160, true), description: clean(value.description, 1_000),
        definition: value.definition, permissionIds: assertRefs(permissionIds(value.permissionIds), `Routine ${value.id}`) };
    }),
    setupChecks: array(raw.setupChecks, 100).map((item) => {
      const value = item as CapabilityPackManifest['setupChecks'][number];
      if (!['integration', 'mcp_preset', 'env', 'path'].includes(String(value.kind))) throw new Error('Invalid setup check kind');
      return { id: id(value.id, 'setup check id'), kind: value.kind, value: clean(value.value, 1_000, true), required: value.required !== false };
    }),
    tests: array(raw.tests, 100).map((item) => {
      const value = item as CapabilityPackManifest['tests'][number];
      if (!['contains', 'permission_declared', 'setup'].includes(String(value.kind))) throw new Error('Invalid pack test kind');
      return { id: id(value.id, 'test id'), kind: value.kind, value: clean(value.value, 1_000, true), target: clean(value.target, 300) };
    }),
    migrations: array(raw.migrations, 50).map((item) => {
      const value = item as CapabilityPackManifest['migrations'][number];
      return { fromVersion: clean(value.fromVersion, 80, true), note: clean(value.note, 2_000, true), reversible: !!value.reversible };
    }),
  };
  if (!VERSION_RE.test(manifest.version)) throw new Error('Pack version must be semantic (for example 1.0.0)');
  if (!manifest.supportedSurfaces.length) manifest.supportedSurfaces = ['agent'];
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error('Pack manifest is too large');
  return manifest;
}

function scanManifest(manifest: CapabilityPackManifest): { passed: boolean; findings: PackScanFinding[] } {
  const findings: PackScanFinding[] = [];
  const text = JSON.stringify(manifest);
  if (looksSensitive(`pack\n${text}`)) findings.push({ severity: 'critical', code: 'embedded-secret', message: 'Manifest appears to contain credential material.' });
  if (/\.\.[/\\]|file:\/\/|\\\\\.\\pipe/i.test(text)) findings.push({ severity: 'high', code: 'path-escape', message: 'Manifest contains a path escape or local file URI.' });
  if (/\b(?:rm\s+-rf|format\s+[a-z]:|powershell.+-enc|curl\b.+\|\s*(?:sh|bash)|wget\b.+\|\s*(?:sh|bash))\b/i.test(text)) {
    findings.push({ severity: 'critical', code: 'dangerous-command', message: 'Manifest contains a destructive or pipe-to-shell command.' });
  }
  for (const server of manifest.mcpServers) {
    if (server.command && !(server.permissionIds || []).some((ref) => manifest.permissions.some((permission) => permission.id === ref && permission.access === 'execute'))) {
      findings.push({ severity: 'high', code: 'undeclared-execution', message: `MCP ${server.id} declares a command without an execute permission.`, path: `mcpServers.${server.id}` });
    }
  }
  return { passed: !findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'), findings };
}

/** Components that do not yet have a governed runtime adapter must never be
 * silently accepted. This also protects old registry entries at use time. */
export function capabilityPackRuntimeIssues(manifest: CapabilityPackManifest): string[] {
  const issues: string[] = [];
  if (manifest.agents.length) issues.push('agent templates');
  if (manifest.hooks.length) issues.push('event hooks');
  if (manifest.migrations.length) issues.push('executable migrations');
  return issues;
}

async function setupChecks(manifest: CapabilityPackManifest): Promise<{ passed: boolean; results: PackCheckResult[] }> {
  const { loadConfig } = await import('./persistence');
  const cfg = await loadConfig();
  const { listMcpServers } = await import('./mcp');
  const servers = await listMcpServers();
  const checks = [...manifest.setupChecks];
  for (const integration of manifest.integrationRequirements) {
    checks.push({ id: `integration-${integration}`.slice(0, 80), kind: 'integration', value: integration, required: true });
  }
  const results: PackCheckResult[] = [];
  for (const check of checks) {
    let passed = false;
    if (check.kind === 'integration') passed = !!(cfg.integrations as Record<string, unknown>)?.[check.value];
    else if (check.kind === 'mcp_preset') passed = servers.some((server) => server.presetId === check.value && server.enabled);
    else if (check.kind === 'env') passed = !!process.env[check.value];
    else if (check.kind === 'path') passed = await fs.stat(path.resolve(check.value)).then(() => true).catch(() => false);
    results.push({ id: check.id, passed: passed || check.required === false, message: passed ? `${check.kind} available` : `${check.kind} ${check.value} is not configured` });
  }
  for (const requirement of manifest.mcpServers) {
    const matched = servers.find((server) => {
      if (!server.enabled) return false;
      if (requirement.presetId && server.presetId !== requirement.presetId) return false;
      if (!requirement.presetId && server.name.trim().toLowerCase() !== requirement.name.trim().toLowerCase()) return false;
      if (requirement.command && server.command !== requirement.command) return false;
      if (requirement.args?.length && JSON.stringify(server.args) !== JSON.stringify(requirement.args)) return false;
      return (requirement.requiredEnv || []).every((key) => !!server.env[key]);
    });
    results.push({
      id: `mcp-${requirement.id}`.slice(0, 80),
      passed: !!matched,
      message: matched
        ? `Enabled MCP requirement ${requirement.name} is configured; activation will not launch or install it.`
        : `Enabled MCP requirement ${requirement.name} with the exact preset/command/environment is not configured.`,
    });
  }
  return { passed: results.every((result) => result.passed), results };
}

function manifestTests(manifest: CapabilityPackManifest, setup: { results: PackCheckResult[] }): { passed: boolean; results: PackCheckResult[] } {
  const serialized = JSON.stringify(manifest);
  const results = manifest.tests.map((test): PackCheckResult => {
    let passed = false;
    if (test.kind === 'contains') passed = serialized.includes(test.value);
    else if (test.kind === 'permission_declared') passed = manifest.permissions.some((permission) => permission.id === test.value);
    else if (test.kind === 'setup') passed = setup.results.some((result) => result.id === test.value && result.passed);
    return { id: test.id, passed, message: passed ? 'Passed' : `${test.kind} check failed for ${test.value}` };
  });
  return { passed: results.every((result) => result.passed), results };
}

function versionManifest(packId: string, version: string): CapabilityPackManifest | null {
  ensureCapabilityPackSchema();
  const row = getDb().prepare('SELECT manifest FROM capability_pack_versions WHERE packId = ? AND version = ?').get(packId, version) as { manifest: string } | undefined;
  return row ? parseJson(row.manifest, null as unknown as CapabilityPackManifest) : null;
}

function diffManifest(previous: CapabilityPackManifest | null, next: CapabilityPackManifest): Record<string, unknown> {
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);
  const delta = (before: string[], after: string[]) => ({ added: after.filter((item) => !before.includes(item)), removed: before.filter((item) => !after.includes(item)) });
  return {
    fromVersion: previous?.version || null, toVersion: next.version,
    skills: delta(previous ? ids(previous.skills) : [], ids(next.skills)),
    commands: delta(previous ? ids(previous.commands) : [], ids(next.commands)),
    agents: delta(previous ? ids(previous.agents) : [], ids(next.agents)),
    mcpServers: delta(previous ? ids(previous.mcpServers) : [], ids(next.mcpServers)),
    routines: delta(previous ? ids(previous.routineTemplates) : [], ids(next.routineTemplates)),
    permissionKeys: delta(previous ? previous.permissions.map(capabilityPermissionKey) : [], next.permissions.map(capabilityPermissionKey)),
  };
}

function proposalFromRow(row: ProposalRow): CapabilityPackProposal {
  return { id: row.id, packId: row.packId, version: row.version,
    status: row.status as CapabilityPackProposal['status'], sourceType: row.sourceType as PackSourceType,
    sourceRef: row.sourceRef, sourceHash: row.sourceHash, manifest: parseJson(row.manifest, {} as CapabilityPackManifest),
    diff: parseJson(row.diff, {}), scan: parseJson(row.scan, { passed: false, findings: [] }),
    tests: parseJson(row.tests, { passed: false, results: [] }), setup: parseJson(row.setup, { passed: false, results: [] }),
    requestedPermissionKeys: parseJson(row.requestedPermissionKeys, []), createdAt: row.createdAt,
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt } : {}) };
}

async function createProposal(manifestInput: unknown, sourceType: PackSourceType, sourceRef: string, sourceContent?: string): Promise<CapabilityPackProposal> {
  ensureCapabilityPackSchema();
  const manifest = normalizeCapabilityPackManifest(manifestInput);
  const current = getCapabilityPack(manifest.id);
  const previous = current?.activeVersion ? versionManifest(manifest.id, current.activeVersion) : null;
  const sourceHash = hash(sourceContent ?? canonical(manifest));
  const existingVersion = versionManifest(manifest.id, manifest.version);
  if (existingVersion && hash(canonical(existingVersion)) !== hash(canonical(manifest))) throw new Error('Pack versions are immutable; choose a new version');
  const scan = scanManifest(manifest);
  const setup = await setupChecks(manifest);
  const tests = manifestTests(manifest, setup);
  const proposal: CapabilityPackProposal = {
    id: randomUUID(), packId: manifest.id, version: manifest.version, status: 'proposed', sourceType,
    sourceRef: clean(sourceRef, 2_000), sourceHash, manifest, diff: diffManifest(previous, manifest), scan, tests, setup,
    requestedPermissionKeys: manifest.permissions.map(capabilityPermissionKey), createdAt: nowIso(),
  };
  getDb().prepare(`INSERT INTO capability_pack_proposals
    (id, packId, version, status, sourceType, sourceRef, sourceHash, manifest, diff, scan, tests, setup, requestedPermissionKeys, createdAt)
    VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposal.id, proposal.packId, proposal.version, sourceType, proposal.sourceRef, sourceHash,
      JSON.stringify(manifest), JSON.stringify(proposal.diff), JSON.stringify(scan), JSON.stringify(tests), JSON.stringify(setup),
      JSON.stringify(proposal.requestedPermissionKeys), proposal.createdAt);
  return proposal;
}

export function proposeCapabilityPackManifest(input: unknown): Promise<CapabilityPackProposal> {
  return createProposal(input, 'manifest', 'inline manifest');
}

function syntheticManifest(idValue: string, name: string, description: string, promptHint: string, version = '1.0.0'): CapabilityPackManifest {
  const packId = id(idValue || name.replace(/[^a-z0-9]+/gi, '-'));
  return normalizeCapabilityPackManifest({ schemaVersion: 1, id: packId, name, version, description,
    supportedSurfaces: ['agent', 'chat'], permissions: [], commands: [], agents: [], mcpServers: [],
    integrationRequirements: [], hooks: [], routineTemplates: [], setupChecks: [], tests: [], migrations: [],
    skills: [{ id: 'workflow', name, description, category: 'automation', promptHint, permissionIds: [] }] });
}

export async function proposeCapabilityPackFromRun(runId: string): Promise<CapabilityPackProposal> {
  ensureCapabilityPackSchema();
  const row = getDb().prepare('SELECT id, prompt, finalOutput, agentName FROM runs WHERE id = ? AND status = ?').get(runId, 'completed') as { id: string; prompt: string; finalOutput: string; agentName: string } | undefined;
  if (!row) throw new Error('A successful completed run is required');
  const name = `Workflow from ${row.agentName || 'run'}`.slice(0, 160);
  const promptHint = [`Reproduce this reviewed successful workflow.`, `Original task: ${row.prompt.slice(0, 4_000)}`, `Successful outcome: ${row.finalOutput.slice(0, 5_000)}`].join('\n');
  return createProposal(syntheticManifest(`learned-run-${hash(runId).slice(0, 12)}`, name, 'Proposed from a successful run.', promptHint), 'run', runId, `${row.prompt}\n${row.finalOutput}`);
}

function privateIp(address: string): boolean {
  if (address === '::1' || address === '::' || /^f[cd]/i.test(address) || /^fe8|^fe9|^fea|^feb/i.test(address)) return true;
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function validateRemoteUrl(raw: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Pack URL must be public HTTPS without credentials or a custom port');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => privateIp(item.address))) throw new Error('Pack URL resolves to a private or reserved address');
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

async function fetchPinnedHttps(target: Awaited<ReturnType<typeof validateRemoteUrl>>): Promise<{
  status: number;
  location?: string;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const request = https.request(target.url, {
      method: 'GET',
      servername: target.url.hostname,
      headers: { 'User-Agent': 'ShibaStudio-PackWorkshop/1', Accept: 'application/json, text/plain;q=0.9' },
      // Pin the address that passed the private/reserved-range check. TLS SNI
      // and Host still use the original hostname, closing the DNS-rebinding
      // gap without weakening certificate validation.
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (response) => {
      const status = response.statusCode || 0;
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > MAX_URL_BYTES) {
        response.destroy(new Error('Pack URL response is too large'));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_URL_BYTES) {
          response.destroy(new Error('Pack URL response is too large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', reject);
      response.once('end', () => resolve({
        status,
        ...(typeof response.headers.location === 'string' ? { location: response.headers.location } : {}),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Pack URL request timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function fetchBoundedHttps(raw: string): Promise<{ url: string; text: string }> {
  let target = await validateRemoteUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchPinnedHttps(target);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirects === 3) throw new Error('Pack URL redirected too many times');
      target = await validateRemoteUrl(new URL(response.location, target.url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Pack URL returned HTTP ${response.status}`);
    return { url: target.url.toString(), text: response.text };
  }
  throw new Error('Pack URL could not be fetched');
}

export async function proposeCapabilityPackFromUrl(rawUrl: string): Promise<CapabilityPackProposal> {
  const fetched = await fetchBoundedHttps(rawUrl);
  let parsed: unknown;
  try { parsed = JSON.parse(fetched.text); }
  catch { parsed = syntheticManifest(`learned-url-${hash(fetched.url).slice(0, 12)}`, new URL(fetched.url).hostname, `Proposed from ${fetched.url}`, fetched.text.slice(0, 10_000)); }
  return createProposal(parsed, 'url', fetched.url, fetched.text);
}

async function readFolderBounded(folder: string): Promise<{ root: string; files: Array<{ path: string; content: string }>; source: string }> {
  const root = await fs.realpath(path.resolve(folder));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Pack source folder is not a directory');
  const files: Array<{ path: string; content: string }> = [];
  const queue = [{ dir: root, depth: 0 }];
  let bytes = 0;
  while (queue.length && files.length < MAX_FOLDER_FILES) {
    const current = queue.shift()!;
    for (const entry of await fs.readdir(current.dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const absolute = path.join(current.dir, entry.name);
      const real = await fs.realpath(absolute).catch(() => '');
      if (!real || (real !== root && !real.startsWith(`${root}${path.sep}`))) continue;
      if (entry.isDirectory() && current.depth < 3) queue.push({ dir: absolute, depth: current.depth + 1 });
      if (!entry.isFile() || !/\.(?:json|md|txt|ya?ml)$/i.test(entry.name)) continue;
      const stat = await fs.stat(absolute);
      if (stat.size > 256_000 || bytes + stat.size > MAX_FOLDER_BYTES) continue;
      const content = await fs.readFile(absolute, 'utf8');
      bytes += Buffer.byteLength(content);
      files.push({ path: path.relative(root, absolute).replace(/\\/g, '/'), content });
    }
  }
  if (!files.length) throw new Error('Folder contains no bounded text pack sources');
  const source = files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => `--- ${file.path}\n${file.content}`).join('\n');
  return { root, files, source };
}

export async function proposeCapabilityPackFromFolder(folder: string): Promise<CapabilityPackProposal> {
  const read = await readFolderBounded(folder);
  const manifestFile = read.files.find((file) => /(?:^|\/)(?:shiba-pack|pack)\.json$/i.test(file.path));
  let manifest: unknown;
  if (manifestFile) manifest = JSON.parse(manifestFile.content);
  else {
    const guide = read.files.find((file) => /\.(?:md|txt)$/i.test(file.path)) || read.files[0];
    manifest = syntheticManifest(`learned-folder-${hash(read.root).slice(0, 12)}`, path.basename(read.root), `Proposed from local folder ${read.root}`, guide.content.slice(0, 10_000));
  }
  return createProposal(manifest, 'folder', read.root, read.source);
}

export function listCapabilityPackProposals(status?: CapabilityPackProposal['status']): CapabilityPackProposal[] {
  ensureCapabilityPackSchema();
  const rows = getDb().prepare(`SELECT * FROM capability_pack_proposals ${status ? 'WHERE status = ?' : ''} ORDER BY createdAt DESC LIMIT 300`)
    .all(...(status ? [status] : [])) as unknown as ProposalRow[];
  return rows.map(proposalFromRow);
}

function packFromRow(row: PackRow, includeManifest = true): CapabilityPackRecord {
  const versions = getDb().prepare('SELECT version FROM capability_pack_versions WHERE packId = ? ORDER BY createdAt DESC').all(row.id) as Array<{ version: string }>;
  return { id: row.id, name: row.name, description: row.description, status: row.status as CapabilityPackRecord['status'],
    ...(row.activeVersion ? { activeVersion: row.activeVersion } : {}), ...(row.previousVersion ? { previousVersion: row.previousVersion } : {}),
    grantedPermissionKeys: parseJson(row.grantedPermissionKeys, []), sourceType: row.sourceType as PackSourceType,
    sourceRef: row.sourceRef, sourceHash: row.sourceHash, usageCount: row.usageCount,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}), ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt } : {}),
    ...(row.lastSuccessRunId ? { lastSuccessRunId: row.lastSuccessRunId } : {}), ...(row.staleAt ? { staleAt: row.staleAt } : {}),
    pinned: !!row.pinned, archived: !!row.archived, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(includeManifest && row.activeVersion ? { manifest: versionManifest(row.id, row.activeVersion) || undefined } : {}),
    availableVersions: versions.map((item) => item.version) };
}

export function getCapabilityPack(packId: string): CapabilityPackRecord | null {
  ensureCapabilityPackSchema();
  const row = getDb().prepare('SELECT * FROM capability_packs WHERE id = ?').get(packId) as unknown as PackRow | undefined;
  return row ? packFromRow(row) : null;
}

export function listCapabilityPacks(options: { includeArchived?: boolean } = {}): CapabilityPackRecord[] {
  ensureCapabilityPackSchema();
  const rows = getDb().prepare(`SELECT * FROM capability_packs ${options.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY pinned DESC, updatedAt DESC`)
    .all() as unknown as PackRow[];
  return rows.map((row) => packFromRow(row));
}

async function safeMode(): Promise<boolean> { return !!(await (await import('./persistence')).loadConfig()).safeMode; }

async function writeRegistry(manifest: CapabilityPackManifest, sourceHash: string, grants: string[]): Promise<void> {
  const dir = path.join(dataDir(), 'capability-packs', 'registry', manifest.id, manifest.version);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'pack.json');
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify({ manifest, sourceHash, approvedPermissionKeys: grants }, null, 2)}\n`);
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export interface CapabilityPackRegistryIntegrityReport {
  missingFilesRebuilt: number;
  corruptFilesRebuilt: number;
  unownedFilesQuarantined: number;
  errors: string[];
}

/** Reconcile the on-disk runtime registry against its authoritative DB versions. */
export async function reconcileCapabilityPackRegistry(options: {
  nowMs?: number;
  minOrphanAgeMs?: number;
} = {}): Promise<CapabilityPackRegistryIntegrityReport> {
  ensureCapabilityPackSchema();
  const nowMs = options.nowMs ?? Date.now();
  const minAge = Math.max(0, options.minOrphanAgeMs ?? 5 * 60_000);
  const root = path.resolve(dataDir(), 'capability-packs', 'registry');
  const report: CapabilityPackRegistryIntegrityReport = {
    missingFilesRebuilt: 0,
    corruptFilesRebuilt: 0,
    unownedFilesQuarantined: 0,
    errors: [],
  };
  const rows = getDb().prepare(`
    SELECT packId, version, manifest, sourceHash, approvedPermissionKeys
    FROM capability_pack_versions
  `).all() as Array<{
    packId: string;
    version: string;
    manifest: string;
    sourceHash: string;
    approvedPermissionKeys: string;
  }>;
  const expected = new Map<string, { manifest: CapabilityPackManifest; sourceHash: string; grants: string[] }>();
  for (const row of rows) {
    try {
      const packId = id(row.packId);
      if (!VERSION_RE.test(row.version)) throw new Error('invalid version');
      const manifest = normalizeCapabilityPackManifest(JSON.parse(row.manifest));
      if (manifest.id !== packId || manifest.version !== row.version) throw new Error('manifest identity differs from its DB owner');
      const target = path.resolve(root, packId, row.version, 'pack.json');
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('registry path escaped root');
      expected.set(target, {
        manifest,
        sourceHash: row.sourceHash,
        grants: parseJson<string[]>(row.approvedPermissionKeys, []),
      });
    } catch (error) {
      report.errors.push(`${row.packId}@${row.version}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const hasCurrentDbOwner = (candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    const segments = relative.split(path.sep);
    if (segments.length !== 3 || segments[2] !== 'pack.json') return false;
    return Boolean(getDb().prepare(`
      SELECT 1 FROM capability_pack_versions WHERE packId = ? AND version = ?
    `).get(segments[0], segments[1]));
  };
  for (const [target, owner] of expected) {
    let rebuild: 'missing' | 'corrupt' | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
      if (canonical(parsed) !== canonical({
        manifest: owner.manifest,
        sourceHash: owner.sourceHash,
        approvedPermissionKeys: owner.grants,
      })) rebuild = 'corrupt';
    } catch (error) {
      rebuild = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'corrupt';
    }
    if (!rebuild) continue;
    try {
      if (rebuild === 'corrupt') {
        // The projection can be repaired concurrently after our first read.
        // Re-read immediately before quarantine so we never move a newly
        // corrected authoritative file based on stale observations.
        try {
          const latest = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
          if (canonical(latest) === canonical({
            manifest: owner.manifest,
            sourceHash: owner.sourceHash,
            approvedPermissionKeys: owner.grants,
          })) continue;
        } catch {
          // Still absent or malformed; the authoritative rewrite below wins.
        }
        const exists = await fs.lstat(target).catch(() => null);
        if (exists) await quarantineManagedPath(target, 'corrupt_capability_pack_registry', {}, nowMs);
      }
      await writeRegistry(owner.manifest, owner.sourceHash, owner.grants);
      if (rebuild === 'missing') report.missingFilesRebuilt += 1;
      else report.corruptFilesRebuilt += 1;
    } catch (error) {
      report.errors.push(`${path.relative(root, target)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (!candidate.startsWith(`${root}${path.sep}`)) continue;
      if (entry.isDirectory()) {
        await walk(candidate);
        // Empty directories are harmless. Removing them races activation's
        // mkdir -> temporary-write window and can make a valid install fail.
        continue;
      }
      if (expected.has(candidate)) continue;
      try {
        const stat = await fs.lstat(candidate);
        // A version may have committed after the initial DB snapshot. Recheck
        // ownership immediately before the destructive quarantine decision.
        if (hasCurrentDbOwner(candidate)) continue;
        // An explicit zero disables the grace period even on filesystems whose
        // sub-millisecond mtime rounds a fraction ahead of Date.now().
        if (minAge > 0 && nowMs - stat.mtimeMs < minAge) continue;
        await quarantineManagedPath(candidate, 'unowned_capability_pack_registry', {}, nowMs);
        report.unownedFilesQuarantined += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        report.errors.push(`${path.relative(root, candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await walk(root).catch((error) => report.errors.push(error instanceof Error ? error.message : String(error)));
  return report;
}

export async function activateCapabilityPackProposal(proposalId: string, approvedPermissionKeys: string[]): Promise<CapabilityPackRecord> {
  if (await safeMode()) throw new Error('Safe mode disables capability pack activation');
  ensureCapabilityPackSchema();
  const row = getDb().prepare('SELECT * FROM capability_pack_proposals WHERE id = ?').get(proposalId) as unknown as ProposalRow | undefined;
  if (!row) throw new Error('Capability pack proposal not found');
  const proposal = proposalFromRow(row);
  if (proposal.status !== 'proposed') throw new Error('Capability pack proposal is no longer pending');
  const unsupported = capabilityPackRuntimeIssues(proposal.manifest);
  if (unsupported.length) throw new Error(`Capability pack activation does not support ${unsupported.join(', ')}; remove those sections and propose a new version`);
  if (!proposal.scan.passed) throw new Error('Security scan must pass before activation');
  if (!proposal.tests.passed) throw new Error('Pack tests must pass before activation');
  if (!proposal.setup.passed) throw new Error('Required setup checks must pass before activation');
  const approved = new Set(approvedPermissionKeys);
  const now = nowIso();
  const db = getDb();
  let registryManifest = proposal.manifest;
  let registrySourceHash = proposal.sourceHash;
  let grants: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentPack = db.prepare('SELECT grantedPermissionKeys FROM capability_packs WHERE id = ?')
      .get(proposal.packId) as { grantedPermissionKeys: string } | undefined;
    const existingGrants = new Set(parseJson<string[]>(currentPack?.grantedPermissionKeys || '[]', []));
    const missing = proposal.requestedPermissionKeys.filter((key) => !existingGrants.has(key) && !approved.has(key));
    if (missing.length) throw new Error(`Explicit approval is required for ${missing.length} new or broadened permission(s)`);
    grants = unique(proposal.requestedPermissionKeys.filter((key) => existingGrants.has(key) || approved.has(key)));
    const versionInsert = db.prepare(`INSERT INTO capability_pack_versions
      (packId, version, manifest, sourceHash, approvedPermissionKeys, proposalId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(packId, version) DO NOTHING`)
      .run(proposal.packId, proposal.version, JSON.stringify(proposal.manifest), proposal.sourceHash, JSON.stringify(grants), proposal.id, now);
    if (Number(versionInsert.changes) === 0) {
      const owner = db.prepare(`
        SELECT manifest, sourceHash, approvedPermissionKeys FROM capability_pack_versions
        WHERE packId = ? AND version = ?
      `).get(proposal.packId, proposal.version) as {
        manifest: string;
        sourceHash: string;
        approvedPermissionKeys: string;
      } | undefined;
      if (!owner) throw new Error('Capability pack version owner disappeared during activation');
      registryManifest = normalizeCapabilityPackManifest(JSON.parse(owner.manifest));
      if (canonical(registryManifest) !== canonical(proposal.manifest)) {
        throw new Error('Pack versions are immutable; choose a new version');
      }
      registrySourceHash = owner.sourceHash;
      grants = parseJson<string[]>(owner.approvedPermissionKeys, []);
    }
    db.prepare(`INSERT INTO capability_packs
      (id, name, description, status, activeVersion, previousVersion, grantedPermissionKeys, sourceType, sourceRef, sourceHash,
       staleAt, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, status = 'active',
       previousVersion = capability_packs.activeVersion, activeVersion = excluded.activeVersion,
       grantedPermissionKeys = excluded.grantedPermissionKeys, sourceType = excluded.sourceType,
       sourceRef = excluded.sourceRef, sourceHash = excluded.sourceHash, staleAt = excluded.staleAt, updatedAt = excluded.updatedAt`)
      .run(proposal.packId, registryManifest.name, registryManifest.description, proposal.version, JSON.stringify(grants),
        proposal.sourceType, proposal.sourceRef, registrySourceHash, staleAt(), now, now);
    const proposalUpdate = db.prepare(`
      UPDATE capability_pack_proposals SET status = 'activated', reviewedAt = ?
      WHERE id = ? AND status = 'proposed'
    `).run(now, proposal.id);
    if (Number(proposalUpdate.changes) !== 1) throw new Error('Capability pack proposal is no longer pending');
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* no transaction */ } throw error; }
  try {
    await writeRegistry(registryManifest, registrySourceHash, grants);
  } catch (error) {
    // Registry bytes are a derived projection. The periodic integrity pass can
    // rebuild them, so a post-commit filesystem failure is not retryable.
    console.error(`[capability-packs] registry write deferred for ${proposal.packId}@${proposal.version}`, error);
  }
  return getCapabilityPack(proposal.packId)!;
}

export function rejectCapabilityPackProposal(proposalId: string): CapabilityPackProposal {
  ensureCapabilityPackSchema();
  const now = nowIso();
  const result = getDb().prepare("UPDATE capability_pack_proposals SET status = 'rejected', reviewedAt = ? WHERE id = ? AND status = 'proposed'").run(now, proposalId);
  if (!result.changes) throw new Error('Pending proposal not found');
  return proposalFromRow(getDb().prepare('SELECT * FROM capability_pack_proposals WHERE id = ?').get(proposalId) as unknown as ProposalRow);
}

export async function rollbackCapabilityPack(packId: string, version: string): Promise<CapabilityPackRecord> {
  if (await safeMode()) throw new Error('Safe mode disables capability pack rollback');
  ensureCapabilityPackSchema();
  const pack = getCapabilityPack(packId);
  if (!pack) throw new Error('Capability pack not found');
  const row = getDb().prepare('SELECT manifest, approvedPermissionKeys, sourceHash FROM capability_pack_versions WHERE packId = ? AND version = ?')
    .get(packId, version) as { manifest: string; approvedPermissionKeys: string; sourceHash: string } | undefined;
  if (!row) throw new Error('Rollback version not found');
  const manifest = parseJson(row.manifest, {} as CapabilityPackManifest);
  const unsupported = capabilityPackRuntimeIssues(manifest);
  if (unsupported.length) throw new Error(`Capability pack rollback cannot activate unsupported ${unsupported.join(', ')}`);
  const grants = parseJson<string[]>(row.approvedPermissionKeys, []);
  const update = getDb().prepare(`UPDATE capability_packs SET previousVersion = activeVersion, activeVersion = ?, name = ?, description = ?,
    status = 'active', grantedPermissionKeys = ?, sourceHash = ?, staleAt = ?, updatedAt = ? WHERE id = ?`)
    .run(version, manifest.name, manifest.description, JSON.stringify(grants), row.sourceHash, staleAt(), nowIso(), packId);
  if (Number(update.changes) !== 1) throw new Error('Capability pack disappeared during rollback');
  try {
    await writeRegistry(manifest, row.sourceHash, grants);
  } catch (error) {
    console.error(`[capability-packs] rollback registry write deferred for ${packId}@${version}`, error);
  }
  return getCapabilityPack(packId)!;
}

export function uninstallCapabilityPack(packId: string): CapabilityPackRecord {
  ensureCapabilityPackSchema();
  const result = getDb().prepare("UPDATE capability_packs SET status = 'uninstalled', previousVersion = activeVersion, activeVersion = NULL, updatedAt = ? WHERE id = ?")
    .run(nowIso(), packId);
  if (!result.changes) throw new Error('Capability pack not found');
  return getCapabilityPack(packId)!;
}

export function updateCapabilityPackMetadata(packId: string, patch: { pinned?: boolean; archived?: boolean; enabled?: boolean }): CapabilityPackRecord {
  const pack = getCapabilityPack(packId);
  if (!pack) throw new Error('Capability pack not found');
  if (patch.enabled && !pack.activeVersion) {
    throw new Error('Activate or roll back to a version before enabling this capability pack');
  }
  getDb().prepare('UPDATE capability_packs SET pinned = ?, archived = ?, status = ?, updatedAt = ? WHERE id = ?')
    .run(patch.pinned ?? pack.pinned ? 1 : 0, patch.archived ?? pack.archived ? 1 : 0,
      patch.enabled === undefined ? pack.status : (patch.enabled ? 'active' : 'disabled'), nowIso(), packId);
  return getCapabilityPack(packId)!;
}

function allowedPermissionIds(pack: CapabilityPackRecord): Set<string> {
  const grants = new Set(pack.grantedPermissionKeys);
  return new Set((pack.manifest?.permissions || []).filter((permission) => grants.has(capabilityPermissionKey(permission))).map((permission) => permission.id));
}

export async function listActiveCapabilityPackSkills(): Promise<SkillPreset[]> {
  if (await safeMode()) return [];
  return listCapabilityPacks().filter((pack) => pack.status === 'active' && pack.manifest && capabilityPackRuntimeIssues(pack.manifest).length === 0).flatMap((pack) => {
    const allowed = allowedPermissionIds(pack);
    return pack.manifest!.skills.filter((skill) => (skill.permissionIds || []).every((permission) => allowed.has(permission)))
      .map((skill) => ({ id: `pack:${pack.id}:${skill.id}`, name: skill.name, description: skill.description, category: skill.category, promptHint: skill.promptHint }));
  });
}

export async function listActiveCapabilityPackCommands() {
  if (await safeMode()) return [];
  return listCapabilityPacks().filter((pack) => pack.status === 'active' && pack.manifest && capabilityPackRuntimeIssues(pack.manifest).length === 0).flatMap((pack) => {
    const allowed = allowedPermissionIds(pack);
    return pack.manifest!.commands.filter((command) => (command.permissionIds || []).every((permission) => allowed.has(permission)))
      .map((command) => ({ ...command, id: `pack:${pack.id}:${command.id}`, packId: pack.id }));
  });
}

export function recordCapabilityPackUsage(skillIds: string[], successfulRunId?: string): void {
  ensureCapabilityPackSchema();
  const packIds = unique(skillIds.map((skill) => skill.match(/^pack:([^:]+):/)?.[1] || '').filter(Boolean));
  const now = nowIso();
  for (const packId of packIds) {
    getDb().prepare(`UPDATE capability_packs SET usageCount = usageCount + 1, lastUsedAt = ?,
      lastSuccessAt = COALESCE(?, lastSuccessAt), lastSuccessRunId = COALESCE(?, lastSuccessRunId),
      staleAt = ?, updatedAt = ? WHERE id = ? AND status = 'active'`)
      .run(now, successfulRunId ? now : null, successfulRunId || null, staleAt(), now, packId);
  }
}

export async function instantiateCapabilityPackRoutine(packId: string, templateId: string, agentId: string) {
  if (await safeMode()) throw new Error('Safe mode disables capability pack use');
  const pack = getCapabilityPack(packId);
  if (!pack || pack.status !== 'active' || !pack.manifest) throw new Error('Active capability pack not found');
  const unsupported = capabilityPackRuntimeIssues(pack.manifest);
  if (unsupported.length) throw new Error(`Capability pack runtime is blocked by unsupported ${unsupported.join(', ')}`);
  const template = pack.manifest.routineTemplates.find((item) => item.id === templateId);
  if (!template) throw new Error('Routine template not found');
  const allowed = allowedPermissionIds(pack);
  if (!(template.permissionIds || []).every((permission) => allowed.has(permission))) throw new Error('Routine template permissions are not approved');
  const { createOwnedRoutine } = await import('./routines');
  return createOwnedRoutine({ ...template.definition, id: `pack-${pack.id}-${template.id}-${randomUUID().slice(0, 8)}`, agentId });
}

export function exportCapabilityPack(packId: string, version?: string): CapabilityPackManifest {
  const pack = getCapabilityPack(packId);
  if (!pack) throw new Error('Capability pack not found');
  const manifest = versionManifest(packId, version || pack.activeVersion || '');
  if (!manifest) throw new Error('Capability pack version not found');
  return manifest;
}

export function listLearningJourney(): LearningJourneyEntry[] {
  const packs: LearningJourneyEntry[] = listCapabilityPacks({ includeArchived: true }).map((pack) => ({
    id: `pack:${pack.id}`, kind: 'pack', title: pack.name, detail: pack.description,
    source: `${pack.sourceType}: ${pack.sourceRef}`, status: pack.status, version: pack.activeVersion,
    pinned: pack.pinned, lastSuccessAt: pack.lastSuccessAt, staleAt: pack.staleAt,
    createdAt: pack.createdAt, updatedAt: pack.updatedAt,
  }));
  const memories: LearningJourneyEntry[] = listMemories({ source: 'learned', limit: 300 }).entries.map((memory) => ({
    id: `memory:${memory.id}`, kind: 'memory', title: memory.key, detail: memory.content,
    source: `run: ${memory.sourceId || 'unknown'}`, status: memory.status, pinned: memory.pinned,
    lastSuccessAt: memory.lastUsedAt, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
  }));
  return [...packs, ...memories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
