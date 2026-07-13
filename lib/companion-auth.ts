// Authentication and pairing for the narrow LAN/Tailscale companion. Raw
// device keys and one-time codes are returned once and never stored.

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { audit } from './audit-log';
import { getDb } from './db';
import { loadConfig, saveConfig } from './persistence';

export const COMPANION_SCOPES = [
  'read:tasks',
  'read:attention',
  'read:routines',
  'action:attention',
  'action:steer',
  'action:cancel',
  'action:routines',
  'action:voice',
] as const;

export type CompanionScope = (typeof COMPANION_SCOPES)[number];

export interface CompanionDevice {
  id: string;
  name: string;
  scopes: CompanionScope[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface CompanionAuthContext {
  device: CompanionDevice;
  scopes: ReadonlySet<CompanionScope>;
}

interface PairingRow {
  id: string;
  codeHash: string;
  requestedScopes: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  attempts: number;
  maxAttempts: number;
}

interface DeviceRow {
  id: string;
  name: string;
  keyHash: string;
  scopes: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface ActionReceiptRow {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  requestHash: string;
  kind: string;
  targetId: string | null;
  status: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
}

export class CompanionAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'CompanionAuthError';
    this.status = status;
  }
}

/** Guarded and idempotent by requirement: no schema-version migration. */
export function ensureCompanionSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS companion_pairings (
      id TEXT PRIMARY KEY,
      codeHash TEXT NOT NULL,
      requestedScopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      consumedAt TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 6
    );
    CREATE INDEX IF NOT EXISTS idx_companion_pairings_expiry
      ON companion_pairings(expiresAt, consumedAt);

    CREATE TABLE IF NOT EXISTS companion_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      keyHash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      lastSeenAt TEXT,
      revokedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_companion_devices_active
      ON companion_devices(revokedAt, expiresAt);

    CREATE TABLE IF NOT EXISTS companion_action_receipts (
      id TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      kind TEXT NOT NULL,
      targetId TEXT,
      status TEXT NOT NULL,
      result TEXT,
      createdAt TEXT NOT NULL,
      completedAt TEXT,
      UNIQUE(deviceId, idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS idx_companion_action_receipts_device
      ON companion_action_receipts(deviceId, createdAt DESC);
  `);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pairingHash(id: string, code: string): string {
  return sha256(`shiba-companion-pairing\0${id}\0${code}`);
}

function deviceKeyHash(key: string): string {
  return sha256(`shiba-companion-device\0${key}`);
}

function parseScopes(raw: string): CompanionScope[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeScopes(parsed);
  } catch {
    return [];
  }
}

function normalizeScopes(scopes: unknown): CompanionScope[] {
  if (!Array.isArray(scopes)) return [];
  const allowed = new Set<string>(COMPANION_SCOPES);
  return [...new Set(scopes.map(String).filter((scope): scope is CompanionScope => allowed.has(scope)))];
}

function rowToDevice(row: DeviceRow): CompanionDevice {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function cleanDeviceName(value: unknown): string {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  if (!name) throw new CompanionAuthError('Device name is required', 400);
  return name;
}

export async function remoteAccessStatus(): Promise<{
  enabled: boolean;
  pairingTtlMinutes: number;
  deviceTtlDays: number;
}> {
  const config = (await loadConfig()).remoteAccess;
  return {
    enabled: config?.enabled === true,
    pairingTtlMinutes: Math.min(10, Math.max(1, Number(config?.pairingTtlMinutes) || 5)),
    deviceTtlDays: Math.min(90, Math.max(1, Number(config?.deviceTtlDays) || 30)),
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** Administrative pairing and revocation are only available on localhost. */
export function requireLocalCompanionAdmin(request: Request): void {
  const url = new URL(request.url);
  if (!isLoopbackHostname(url.hostname)) {
    throw new CompanionAuthError('Companion administration is available only on localhost', 403);
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) throw new Error('not loopback');
    } catch {
      throw new CompanionAuthError('Companion administration requires a localhost origin', 403);
    }
  }
}

export async function setRemoteAccessEnabled(enabled: boolean): Promise<void> {
  const current = await remoteAccessStatus();
  await saveConfig({ remoteAccess: { ...current, enabled } });
  ensureCompanionSchema();
  if (!enabled) {
    getDb().prepare(`
      UPDATE companion_pairings SET consumedAt = ? WHERE consumedAt IS NULL
    `).run(nowIso());
  }
  audit('auth', enabled ? 'companion remote access enabled' : 'companion remote access disabled', undefined, {
    remoteAccess: enabled,
  });
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 127;
}

export function validateCompanionOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CompanionAuthError('A valid LAN or Tailscale companion origin is required', 400);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new CompanionAuthError('Companion origin must be HTTP(S) without credentials', 400);
  }
  const host = url.hostname.toLowerCase();
  const allowed = isLoopbackHostname(host)
    || isPrivateIpv4(host)
    || host.endsWith('.local')
    || host.endsWith('.ts.net')
    || host.startsWith('[') && (host.includes('fc') || host.includes('fd') || host.includes('fe8'));
  if (!allowed) throw new CompanionAuthError('Companion origin must be LAN, .local, or Tailscale', 400);
  return url.origin;
}

function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = randomBytes(10);
  return [...random].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export async function createCompanionPairing(input: {
  companionOrigin: string;
  scopes?: unknown;
}): Promise<{
  id: string;
  code: string;
  pairingUrl: string;
  scopes: CompanionScope[];
  expiresAt: string;
}> {
  const status = await remoteAccessStatus();
  if (!status.enabled) throw new CompanionAuthError('Remote companion access is disabled', 403);
  ensureCompanionSchema();
  const scopes = normalizeScopes(input.scopes);
  const effectiveScopes = scopes.length ? scopes : [...COMPANION_SCOPES];
  const origin = validateCompanionOrigin(input.companionOrigin);
  const id = randomUUID();
  const code = pairingCode();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + status.pairingTtlMinutes * 60_000).toISOString();
  getDb().prepare(`
    INSERT INTO companion_pairings
      (id, codeHash, requestedScopes, createdAt, expiresAt, consumedAt, attempts, maxAttempts)
    VALUES (?, ?, ?, ?, ?, NULL, 0, 6)
  `).run(id, pairingHash(id, code), JSON.stringify(effectiveScopes), createdAt, expiresAt);
  const pairingUrl = `${origin}/companion?pair=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;
  audit('auth', 'companion pairing created', `expires ${expiresAt}`, { pairingId: id, scopes: effectiveScopes });
  return { id, code, pairingUrl, scopes: effectiveScopes, expiresAt };
}

export async function exchangeCompanionPairing(input: {
  id: string;
  code: string;
  deviceName: string;
}): Promise<{ device: CompanionDevice; deviceKey: string }> {
  const status = await remoteAccessStatus();
  if (!status.enabled) throw new CompanionAuthError('Remote companion access is disabled', 403);
  ensureCompanionSchema();
  const id = String(input.id || '').trim();
  const code = String(input.code || '').trim().toUpperCase();
  const name = cleanDeviceName(input.deviceName);
  if (!id || !code) throw new CompanionAuthError('Pairing id and code are required', 400);
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM companion_pairings WHERE id = ?').get(id) as unknown as PairingRow | undefined;
    const generic = new CompanionAuthError('Pairing code is invalid or expired', 401);
    if (!row || row.consumedAt || row.attempts >= row.maxAttempts || Date.parse(row.expiresAt) <= Date.now()) throw generic;
    const supplied = Buffer.from(pairingHash(id, code), 'hex');
    const expected = Buffer.from(row.codeHash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      db.prepare('UPDATE companion_pairings SET attempts = attempts + 1 WHERE id = ?').run(id);
      db.exec('COMMIT');
      throw generic;
    }

    const consumedAt = nowIso();
    const consume = db.prepare(`
      UPDATE companion_pairings SET consumedAt = ?, attempts = attempts + 1
      WHERE id = ? AND consumedAt IS NULL
    `).run(consumedAt, id);
    if (Number(consume.changes) !== 1) throw generic;
    const deviceId = randomUUID();
    const deviceKey = `shiba_cmp_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + status.deviceTtlDays * 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO companion_devices
        (id, name, keyHash, scopes, createdAt, expiresAt, lastSeenAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(deviceId, name, deviceKeyHash(deviceKey), row.requestedScopes, consumedAt, expiresAt, consumedAt);
    db.exec('COMMIT');
    const device = rowToDevice(db.prepare('SELECT * FROM companion_devices WHERE id = ?').get(deviceId) as unknown as DeviceRow);
    audit('auth', 'companion device paired', name, { deviceId, pairingId: id, scopes: device.scopes });
    return { device, deviceKey };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be committed */ }
    throw error;
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(shiba_cmp_[A-Za-z0-9_-]{30,})$/i);
  if (!match) throw new CompanionAuthError('A paired companion device key is required', 401);
  return match[1];
}

export async function authenticateCompanion(request: Request): Promise<CompanionAuthContext> {
  const status = await remoteAccessStatus();
  if (!status.enabled) throw new CompanionAuthError('Remote companion access is disabled', 403);
  ensureCompanionSchema();
  const token = bearerToken(request);
  const row = getDb().prepare('SELECT * FROM companion_devices WHERE keyHash = ?')
    .get(deviceKeyHash(token)) as unknown as DeviceRow | undefined;
  if (!row || row.revokedAt || Date.parse(row.expiresAt) <= Date.now()) {
    throw new CompanionAuthError('Companion device key is expired or revoked', 401);
  }
  const lastSeenAt = nowIso();
  getDb().prepare('UPDATE companion_devices SET lastSeenAt = ? WHERE id = ?').run(lastSeenAt, row.id);
  const device = rowToDevice({ ...row, lastSeenAt });
  return { device, scopes: new Set(device.scopes) };
}

export async function requireCompanionScope(request: Request, scope: CompanionScope): Promise<CompanionAuthContext> {
  const auth = await authenticateCompanion(request);
  if (!auth.scopes.has(scope)) throw new CompanionAuthError(`Companion device lacks ${scope} permission`, 403);
  return auth;
}

export function listCompanionDevices(): CompanionDevice[] {
  ensureCompanionSchema();
  return (getDb().prepare('SELECT * FROM companion_devices ORDER BY createdAt DESC').all() as unknown as DeviceRow[])
    .map(rowToDevice);
}

export function revokeCompanionDevice(id: string): CompanionDevice {
  ensureCompanionSchema();
  const revokedAt = nowIso();
  const result = getDb().prepare(`
    UPDATE companion_devices SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL
  `).run(revokedAt, String(id || '').trim());
  if (Number(result.changes) !== 1) throw new CompanionAuthError('Active companion device not found', 404);
  const row = getDb().prepare('SELECT * FROM companion_devices WHERE id = ?').get(id) as unknown as DeviceRow;
  const device = rowToDevice(row);
  audit('auth', 'companion device revoked', device.name, { deviceId: device.id });
  return device;
}

export interface CompanionActionReceipt {
  state: 'new' | 'replay' | 'pending';
  id: string;
  result?: Record<string, unknown>;
}

export interface CompanionVoiceAction {
  id: string;
  idempotencyKey: string;
  status: 'pending' | 'completed' | 'failed';
  result: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

function receiptResult(row: ActionReceiptRow): Record<string, unknown> {
  if (!row.result) return {};
  try {
    const value = JSON.parse(row.result) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function companionActionDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function beginCompanionAction(input: {
  deviceId: string;
  idempotencyKey: string;
  kind: string;
  targetId?: string;
  request: unknown;
}): CompanionActionReceipt {
  ensureCompanionSchema();
  const key = String(input.idempotencyKey || '').trim().slice(0, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(key)) {
    throw new CompanionAuthError('A stable idempotencyKey is required', 400);
  }
  const requestHash = companionActionDigest(input.request);
  const db = getDb();
  const existing = db.prepare(`
    SELECT * FROM companion_action_receipts WHERE deviceId = ? AND idempotencyKey = ?
  `).get(input.deviceId, key) as unknown as ActionReceiptRow | undefined;
  if (existing) {
    if (existing.requestHash !== requestHash) throw new CompanionAuthError('Idempotency key was reused for a different action', 409);
    if (existing.status === 'pending') return { state: 'pending', id: existing.id, result: receiptResult(existing) };
    return {
      state: 'replay',
      id: existing.id,
      result: receiptResult(existing),
    };
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO companion_action_receipts
      (id, deviceId, idempotencyKey, requestHash, kind, targetId, status, result, createdAt, completedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
  `).run(id, input.deviceId, key, requestHash, input.kind.slice(0, 80), input.targetId || null, nowIso());
  return { state: 'new', id };
}

export function updateCompanionActionProgress(id: string, result: Record<string, unknown>): void {
  ensureCompanionSchema();
  const update = getDb().prepare(`
    UPDATE companion_action_receipts SET result = ? WHERE id = ? AND status = 'pending'
  `).run(JSON.stringify(result).slice(0, 8_000), id);
  if (Number(update.changes) !== 1) throw new Error('Companion action receipt is not pending');
}

export function listCompanionVoiceActions(deviceId: string, limit = 10): CompanionVoiceAction[] {
  ensureCompanionSchema();
  const rows = getDb().prepare(`
    SELECT * FROM companion_action_receipts
    WHERE deviceId = ? AND kind = 'voice'
    ORDER BY createdAt DESC LIMIT ?
  `).all(deviceId, Math.max(1, Math.min(50, Number(limit) || 10))) as unknown as ActionReceiptRow[];
  return rows.map((row) => {
    const stored = receiptResult(row);
    const result = {
      ...(typeof stored.status === 'string' ? { status: stored.status.slice(0, 40) } : {}),
      ...(typeof stored.title === 'string' ? { title: stored.title.slice(0, 160) } : {}),
      ...(typeof stored.taskId === 'string' ? { taskId: stored.taskId.slice(0, 160) } : {}),
      ...(typeof stored.error === 'string' ? { error: stored.error.slice(0, 500) } : {}),
    };
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      status: row.status as CompanionVoiceAction['status'],
      result,
      createdAt: row.createdAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    };
  });
}

export async function reconcileInterruptedCompanionVoiceActions(): Promise<{
  completed: number;
  resumed: number;
  failed: number;
}> {
  ensureCompanionSchema();
  const rows = getDb().prepare(`
    SELECT * FROM companion_action_receipts
    WHERE kind = 'voice' AND status = 'pending'
    ORDER BY createdAt ASC
  `).all() as unknown as ActionReceiptRow[];
  let completed = 0;
  let resumed = 0;
  let failed = 0;
  for (const row of rows) {
    const stored = receiptResult(row);
    const taskId = typeof stored.taskId === 'string' ? stored.taskId : `companion-voice:${row.id}`;
    const title = typeof stored.title === 'string' ? stored.title.slice(0, 160) : 'Voice request';
    const meetingId = typeof stored.meetingId === 'string' ? stored.meetingId : undefined;
    if (taskId) {
      const { getTask } = await import('./task-ledger');
      const task = getTask(taskId);
      if (task) {
        try {
          if (task.status === 'queued') {
            const { dispatchExistingTask } = await import('./background-tasks');
            await dispatchExistingTask(task.id);
            resumed += 1;
          }
          finishCompanionAction(row.id, {
            ok: true,
            status: 'dispatched',
            title,
            taskId: task.id,
            ...(meetingId ? { meetingId } : {}),
          });
          completed += 1;
          continue;
        } catch (error) {
          audit('auth', 'companion voice resume failed', error instanceof Error ? error.message : String(error), {
            deviceId: row.deviceId,
            taskId,
            meetingId,
          });
        }
      }
    }
    finishCompanionAction(row.id, {
      ok: false,
      status: 'failed',
      title,
      error: 'Voice processing was interrupted on the host. Record and send a new request.',
      ...(meetingId ? { meetingId } : {}),
    }, false);
    failed += 1;
  }
  return { completed, resumed, failed };
}

export function finishCompanionAction(id: string, result: Record<string, unknown>, succeeded = true): void {
  ensureCompanionSchema();
  const update = getDb().prepare(`
    UPDATE companion_action_receipts SET status = ?, result = ?, completedAt = ?
    WHERE id = ? AND status = 'pending'
  `).run(succeeded ? 'completed' : 'failed', JSON.stringify(result).slice(0, 8_000), nowIso(), id);
  if (Number(update.changes) !== 1) throw new Error('Companion action receipt is not pending');
}
