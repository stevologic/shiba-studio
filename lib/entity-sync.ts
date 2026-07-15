// Entity-level cloud sync — push/pull Shiba Studio entities (agents, automations, projects,
// Board cards, chats, workspace uploads, local-model settings) to/from the xAI cloud file store.
// Each entity kind is serialized as one JSON snapshot file so any Shiba Studio install
// connected to the same xAI account can pull it down.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadAgents, mutateAgents, loadConfig, saveConfig, withAgentOwnershipSnapshot } from './persistence';
import { normalizeAgent, type Agent } from './types';
import { listProjects, updateProject, createProject } from './projects';
import { listChatSessions, createChatSession, updateChatSession, type ChatSession } from './chat-sessions';
import {
  listBoardCloudTasks,
  mergeBoardCloudTasks,
  type BoardCloudTask,
} from './board';
import { syncUploadToCloud, syncDownloadFromCloud } from './cloud-sync';
import { downloadXaiFileContent, listXaiFiles } from './xai-files';
import { resolveCloudBearer } from './xai-oauth';
import { setApiKey } from './grok-client';
import {
  getActiveOwnedXaiResourceId,
  processPendingOwnedXaiDeletions,
  uploadOwnedXaiEntitySnapshot,
  type OwnedXaiAuthSource,
} from './external-resource-integrity';
import { isSupportedAutomationCron } from './automation-cron';
import {
  createRoutine,
  getRoutine,
  listRoutines,
  migrateLegacyAgentSchedules,
  updateRoutine,
} from './routines';
import type { CreateRoutineInput, RoutineDefinition } from './routine-types';

export type SyncKind = 'agents' | 'automations' | 'projects' | 'board' | 'chats' | 'workspace' | 'models';

export const SYNC_KINDS: SyncKind[] = ['agents', 'automations', 'projects', 'board', 'chats', 'workspace', 'models'];

export interface SyncKindResult {
  kind: SyncKind;
  ok: boolean;
  detail: string;
  error?: string;
}

const SNAPSHOT_PREFIX = 'shiba-sync-';
// Snapshots pushed before the rebrand still sit in xAI storage under this name.
const LEGACY_SNAPSHOT_PREFIX = 'grokdesk-sync-';
const AUTOMATION_SNAPSHOT_SCHEMA = 'shiba.automations/v1' as const;
const AUTOMATION_SNAPSHOT_VERSION = 1 as const;
const BOARD_SNAPSHOT_SCHEMA = 'shiba.board/v1' as const;
const BOARD_SNAPSHOT_VERSION = 1 as const;
const XAI_FILE_MAX_BYTES = 48 * 1024 * 1024;
// uploadOwnedXaiEntitySnapshot adds an ownership envelope around this payload.
const BOARD_SNAPSHOT_ENVELOPE_RESERVE_BYTES = 16 * 1024;
const REDACTED_SECRET = '••••••••';

const boardTimestampSchema = z.string().max(40).datetime({ offset: true });
const boardCloudTaskSchema: z.ZodType<BoardCloudTask> = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]+$/),
  key: z.string().trim().min(1).max(64).regex(/^[\x20-\x7E]+$/),
  title: z.string().min(1).max(300).refine((value) => value.trim() === value, 'Task title must be trimmed'),
  description: z.string().max(20_000),
  status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  labels: z.array(
    z.string().min(1).max(255).refine((value) => value.trim() === value, 'Labels must be trimmed'),
  ).max(10),
  createdAt: boardTimestampSchema,
  syncUpdatedAt: boardTimestampSchema,
}).strict();

const boardCloudSnapshotSchema = z.object({
  schema: z.literal(BOARD_SNAPSHOT_SCHEMA),
  version: z.literal(BOARD_SNAPSHOT_VERSION),
  exportedAt: boardTimestampSchema,
  tasks: z.array(boardCloudTaskSchema).max(10_000),
}).strict().superRefine((snapshot, context) => {
  const ids = new Set<string>();
  snapshot.tasks.forEach((task, index) => {
    if (ids.has(task.id)) {
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'id'],
        message: 'Duplicate Board task id',
      });
    }
    ids.add(task.id);
    if (Date.parse(task.syncUpdatedAt) < Date.parse(task.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'syncUpdatedAt'],
        message: 'Task sync timestamp predates its creation timestamp',
      });
    }
  });
});

type BoardCloudSnapshot = z.infer<typeof boardCloudSnapshotSchema>;

interface AutomationRoutineSnapshot extends CreateRoutineInput {
  id: string;
  sourceVersion: number;
  updatedAt: string;
}

interface AutomationSnapshot {
  schema: typeof AUTOMATION_SNAPSHOT_SCHEMA;
  version: typeof AUTOMATION_SNAPSHOT_VERSION;
  exportedAt: string;
  routines: AutomationRoutineSnapshot[];
}

interface LegacyScheduleEntry {
  id?: unknown;
  enabled?: unknown;
  cron?: unknown;
  instructions?: unknown;
  description?: unknown;
}

interface LegacyScheduleGroup {
  agentId: string;
  agentName?: string;
  schedules: LegacyScheduleEntry[];
}

interface LegacyMigrationResult {
  created: number;
  existing: number;
  invalid: number;
  skipped: number;
}

interface RoutineApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function snapshotName(kind: SyncKind): string {
  return `${SNAPSHOT_PREFIX}${kind}.json`;
}

function boardSnapshotFromUnknown(value: unknown): BoardCloudSnapshot {
  const parsed = boardCloudSnapshotSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const location = first?.path.length ? ` at ${first.path.join('.')}` : '';
  throw new Error(`Cloud Board snapshot is malformed${location}: ${first?.message || 'invalid payload'}`);
}

function assertBoardSnapshotFitsXaiFile(snapshot: BoardCloudSnapshot): void {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  const safePayloadLimit = XAI_FILE_MAX_BYTES - BOARD_SNAPSHOT_ENVELOPE_RESERVE_BYTES;
  if (bytes > safePayloadLimit) {
    throw new Error(
      `Board snapshot is ${bytes} bytes and exceeds the safe payload limit for xAI's 48 MB per-file cap. No cards were uploaded.`,
    );
  }
}

async function requireCloudAuth(): Promise<{ token: string; source: OwnedXaiAuthSource }> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) throw new Error('Cloud credentials required (xAI API key or OAuth with X)');
  setApiKey(auth.token);
  return { token: auth.token, source: auth.source };
}

/** Upload a JSON snapshot, replacing older snapshots of the same kind to avoid clutter. */
async function pushSnapshot(
  kind: SyncKind,
  payload: unknown,
  auth: { token: string; source: OwnedXaiAuthSource },
): Promise<string> {
  const name = snapshotName(kind);
  const meta = await uploadOwnedXaiEntitySnapshot({
    ownerKey: `entity-sync:${kind}`,
    filename: name,
    kind,
    payload,
    authToken: auth.token,
    authSource: auth.source,
  });
  // Replacement tombstones are already durable. Try them now for responsive
  // cleanup; provider/network failures remain queued for coordinator retries.
  await processPendingOwnedXaiDeletions({
    kind: 'entity_snapshot',
    tombstoneGraceMs: 0,
    deleteBatchSize: 20,
  })
    .catch(() => undefined);
  return meta.id;
}

async function pullSnapshot<T>(kind: SyncKind): Promise<T | null> {
  const all = await listXaiFiles();
  const ownedId = getActiveOwnedXaiResourceId('entity_snapshot', `entity-sync:${kind}`);
  const owned = ownedId ? all.find((file) => file.id === ownedId) : undefined;
  const latestNamed = (name: string) =>
    all.filter((f) => f.filename === name).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  // Prefer current snapshots; fall back to pre-rebrand ones so a fresh install
  // can still pull entities pushed by an older version.
  const files = owned
    ? [owned]
    : latestNamed(snapshotName(kind)).length
    ? latestNamed(snapshotName(kind))
    : latestNamed(`${LEGACY_SNAPSHOT_PREFIX}${kind}.json`);
  if (!files.length) return null;
  const buf = await downloadXaiFileContent(files[0].id);
  const parsed = JSON.parse(buf.toString('utf8'));
  return (parsed?.payload ?? parsed) as T;
}

function newer(a?: string, b?: string): boolean {
  return new Date(a || 0).getTime() > new Date(b || 0).getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function legacyScheduleEntries(value: unknown): LegacyScheduleEntry[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.schedules) && value.schedules.length > 0) {
    return value.schedules.filter(isRecord);
  }
  return isRecord(value.schedule) ? [value.schedule] : [];
}

function hasLegacyScheduleFields(value: unknown): boolean {
  return isRecord(value)
    && (Object.prototype.hasOwnProperty.call(value, 'schedules')
      || Object.prototype.hasOwnProperty.call(value, 'schedule'));
}

function stripLegacyAgentScheduleFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sanitized = { ...value };
  delete sanitized.schedules;
  delete sanitized.schedule;
  return sanitized;
}

function legacyScheduleGroupsFromAgents(value: unknown): LegacyScheduleGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: LegacyScheduleGroup[] = [];
  for (const agent of value) {
    if (!hasLegacyScheduleFields(agent)) continue;
    const record = agent as Record<string, unknown>;
    const agentName = cleanText(record.name, 300);
    groups.push({
      agentId: cleanText(record.id, 160),
      ...(agentName ? { agentName } : {}),
      schedules: legacyScheduleEntries(record),
    });
  }
  return groups;
}

function legacyScheduleGroupsFromSnapshot(value: unknown[]): LegacyScheduleGroup[] {
  const groups: LegacyScheduleGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const agentName = cleanText(item.agentName, 300);
    groups.push({
      agentId: cleanText(item.agentId, 160),
      ...(agentName ? { agentName } : {}),
      schedules: legacyScheduleEntries(item),
    });
  }
  return groups;
}

function legacyScheduleRoutineId(agentId: string, entry: LegacyScheduleEntry, index: number): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    agentId,
    index,
    id: entry.id,
    cron: entry.cron,
    instructions: entry.instructions,
    description: entry.description,
  })).digest('hex').slice(0, 32);
  return `legacy-agent-schedule:${fingerprint}`;
}

async function migrateLegacyScheduleGroups(
  groups: LegacyScheduleGroup[],
  agents: Agent[],
): Promise<LegacyMigrationResult> {
  const knownAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const result: LegacyMigrationResult = { created: 0, existing: 0, invalid: 0, skipped: 0 };

  return withAgentOwnershipSnapshot(async (currentAgentIds) => {
  for (const group of groups) {
    const agent = knownAgents.get(group.agentId);
    if (!agent || !currentAgentIds.has(group.agentId)) {
      result.skipped += group.schedules.length;
      continue;
    }

    for (const [index, entry] of group.schedules.entries()) {
      const cronExpression = typeof entry.cron === 'string' ? entry.cron.trim() : '';
      const prompt = cleanText(
        typeof entry.instructions === 'string' ? entry.instructions : entry.description,
        20_000,
      ) || 'Perform the scheduled task.';
      const legacyDescription = cleanText(entry.description, 5_000);
      const id = legacyScheduleRoutineId(agent.id, entry, index);
      const validCron = isSupportedAutomationCron(cronExpression);
      if (!validCron) result.invalid++;

      if (getRoutine(id)) {
        result.existing++;
        continue;
      }

      try {
        createRoutine({
          id,
          name: cleanText(legacyDescription || prompt, 100) || `${agent.name} automation`,
          description: validCron
            ? `Migrated from an agent schedule.${legacyDescription ? ` ${legacyDescription}` : ''}`
            : `Migrated from an agent schedule with an invalid cron expression (${cronExpression || 'empty'}). Review the trigger and enable this Automation.${legacyDescription ? ` ${legacyDescription}` : ''}`,
          enabled: validCron && entry.enabled === true,
          agentId: agent.id,
          prompt,
          triggers: validCron
            ? [{ id: 'schedule', type: 'schedule', enabled: true, cron: cronExpression }]
            : [{ id: 'manual', type: 'manual', enabled: true }],
          parameters: {
            migratedFrom: 'agent_schedule',
            ...(typeof entry.id === 'string' && entry.id ? { legacyScheduleId: entry.id } : {}),
            ...(cronExpression ? { legacyCron: cronExpression } : {}),
          },
          retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 },
          catchUpPolicy: 'run_once',
          circuitBreaker: { failureThreshold: 3, cooldownSeconds: 900 },
        });
        result.created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(message)) result.existing++;
        else throw error;
      }
    }
  }

  return result;
  });
}

function routineToSnapshot(routine: RoutineDefinition): AutomationRoutineSnapshot {
  return {
    id: routine.id,
    sourceVersion: routine.version,
    updatedAt: routine.updatedAt,
    name: routine.name,
    description: routine.description,
    enabled: routine.enabled,
    agentId: routine.agentId,
    prompt: routine.prompt,
    triggers: routine.triggers,
    conditions: routine.conditions,
    parameters: routine.parameters,
    retryPolicy: routine.retryPolicy,
    timeoutMs: routine.timeoutMs,
    concurrencyKey: routine.concurrencyKey,
    catchUpPolicy: routine.catchUpPolicy,
    circuitBreaker: routine.circuitBreaker,
    steps: routine.steps,
  };
}

function routineInput(snapshot: AutomationRoutineSnapshot): CreateRoutineInput {
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    enabled: snapshot.enabled,
    agentId: snapshot.agentId,
    prompt: snapshot.prompt,
    triggers: snapshot.triggers,
    conditions: snapshot.conditions,
    parameters: snapshot.parameters,
    retryPolicy: snapshot.retryPolicy,
    timeoutMs: snapshot.timeoutMs,
    concurrencyKey: snapshot.concurrencyKey,
    catchUpPolicy: snapshot.catchUpPolicy,
    circuitBreaker: snapshot.circuitBreaker,
    steps: snapshot.steps,
  };
}

function automationSnapshotFromUnknown(value: unknown): AutomationSnapshot {
  if (!isRecord(value)) throw new Error('Cloud Automations snapshot is malformed');
  if (value.schema !== AUTOMATION_SNAPSHOT_SCHEMA) {
    throw new Error(`Unsupported cloud Automations snapshot schema: ${cleanText(value.schema, 100) || 'missing'}`);
  }
  if (value.version !== AUTOMATION_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported cloud Automations snapshot version: ${String(value.version ?? 'missing')}`);
  }
  if (!Array.isArray(value.routines)) throw new Error('Cloud Automations snapshot has no routines list');
  for (const routine of value.routines) {
    if (!isRecord(routine)
      || typeof routine.id !== 'string'
      || typeof routine.agentId !== 'string'
      || typeof routine.name !== 'string'
      || typeof routine.prompt !== 'string'
      || typeof routine.updatedAt !== 'string'
      || !Array.isArray(routine.triggers)) {
      throw new Error('Cloud Automations snapshot contains a malformed Routine');
    }
  }
  return value as unknown as AutomationSnapshot;
}

function unresolvedRedactedWebhook(snapshot: AutomationRoutineSnapshot, existing: RoutineDefinition | null): boolean {
  const existingById = new Map((existing?.triggers || []).map((trigger) => [trigger.id, trigger]));
  return snapshot.triggers.some((trigger) => trigger.type === 'webhook'
    && trigger.secret === REDACTED_SECRET
    && existingById.get(trigger.id)?.type !== 'webhook');
}

async function applyRoutineSnapshots(
  snapshots: AutomationRoutineSnapshot[],
  agents: Agent[],
): Promise<RoutineApplyResult> {
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  const result: RoutineApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  return withAgentOwnershipSnapshot(async (currentAgentIds) => {
  for (const snapshot of snapshots) {
    if (!knownAgentIds.has(snapshot.agentId) || !currentAgentIds.has(snapshot.agentId)) {
      result.skipped++;
      continue;
    }
    let existing = getRoutine(snapshot.id);
    if (unresolvedRedactedWebhook(snapshot, existing)) {
      result.skipped++;
      continue;
    }
    if (!existing) {
      try {
        createRoutine(routineInput(snapshot));
        result.created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) throw error;
        result.skipped++;
      }
      continue;
    }
    if (!newer(snapshot.updatedAt, existing.updatedAt)) {
      result.unchanged++;
      continue;
    }

    try {
      updateRoutine(snapshot.id, routineInput(snapshot), existing.version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/changed concurrently/i.test(message)) throw error;
      existing = getRoutine(snapshot.id);
      if (!existing || !newer(snapshot.updatedAt, existing.updatedAt)) {
        result.unchanged++;
        continue;
      }
      if (unresolvedRedactedWebhook(snapshot, existing)) {
        result.skipped++;
        continue;
      }
      updateRoutine(snapshot.id, routineInput(snapshot), existing.version);
    }
    result.updated++;
  }

  return result;
  });
}

function listAllRoutines(): RoutineDefinition[] {
  const routines: RoutineDefinition[] = [];
  const limit = 500;
  let offset = 0;
  while (true) {
    const page = listRoutines({ limit, offset });
    routines.push(...page.routines);
    offset += page.routines.length;
    if (offset >= page.total || page.routines.length === 0) return routines;
  }
}

/** Merge cloud agents into local by id — newest updatedAt wins; unseen agents are added. */
function mergeAgents(local: Agent[], cloud: unknown[]): { merged: Agent[]; added: number; updated: number } {
  const byId = new Map(local.map((a) => [a.id, a]));
  let added = 0;
  let updated = 0;
  for (const raw of cloud) {
    if (!isRecord(raw)) continue;
    const incoming = normalizeAgent(raw);
    if (!cleanText(incoming.id, 160)) continue;
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      added++;
    } else if (newer(incoming.updatedAt, existing.updatedAt)) {
      byId.set(incoming.id, incoming);
      updated++;
    }
  }
  return { merged: Array.from(byId.values()), added, updated };
}

export async function pushKind(kind: SyncKind): Promise<SyncKindResult> {
  try {
    const auth = await requireCloudAuth();

    if (kind === 'workspace') {
      const res = await syncUploadToCloud();
      return {
        kind,
        ok: res.errors.length === 0,
        detail: `${res.uploaded.length} uploaded, ${res.skipped.length} up to date`,
        error: res.errors.join('; ') || undefined,
      };
    }

    if (kind === 'agents') {
      await migrateLegacyAgentSchedules();
      const agents = await loadAgents();
      await pushSnapshot(kind, agents.map(stripLegacyAgentScheduleFields), auth);
      return { kind, ok: true, detail: `${agents.length} agent(s) pushed` };
    }

    if (kind === 'automations') {
      await migrateLegacyAgentSchedules();
      const routines = listAllRoutines();
      const snapshot: AutomationSnapshot = {
        schema: AUTOMATION_SNAPSHOT_SCHEMA,
        version: AUTOMATION_SNAPSHOT_VERSION,
        exportedAt: new Date().toISOString(),
        routines: routines.map(routineToSnapshot),
      };
      await pushSnapshot(kind, snapshot, auth);
      return { kind, ok: true, detail: `${routines.length} Automation(s) pushed` };
    }

    if (kind === 'board') {
      const tasks = await listBoardCloudTasks();
      const snapshot = boardSnapshotFromUnknown({
        schema: BOARD_SNAPSHOT_SCHEMA,
        version: BOARD_SNAPSHOT_VERSION,
        exportedAt: new Date().toISOString(),
        tasks,
      });
      assertBoardSnapshotFitsXaiFile(snapshot);
      await pushSnapshot(kind, snapshot, auth);
      return { kind, ok: true, detail: `${tasks.length} Board card(s) pushed` };
    }

    if (kind === 'projects') {
      const projects = await listProjects();
      await pushSnapshot(kind, projects, auth);
      return { kind, ok: true, detail: `${projects.length} project(s) pushed (metadata + chat history)` };
    }

    if (kind === 'chats') {
      const sessions = await listChatSessions({ includeArchived: true });
      await pushSnapshot(kind, sessions, auth);
      return { kind, ok: true, detail: `${sessions.length} chat session(s) pushed` };
    }

    if (kind === 'models') {
      const cfg = await loadConfig();
      if (!cfg.localGrokEnabled) {
        return { kind, ok: true, detail: 'Skipped — no local model in use' };
      }
      await pushSnapshot(kind, {
        localGrokEnabled: cfg.localGrokEnabled,
        localGrokBaseUrl: cfg.localGrokBaseUrl,
        defaultGrokModel: cfg.defaultGrokModel,
      }, auth);
      return { kind, ok: true, detail: 'Local model settings pushed' };
    }

    return { kind, ok: false, detail: '', error: `Unknown sync kind: ${kind}` };
  } catch (e: unknown) {
    return { kind, ok: false, detail: '', error: e instanceof Error ? e.message : 'Sync failed' };
  }
}

export async function pullKind(kind: SyncKind): Promise<SyncKindResult> {
  try {
    await requireCloudAuth();

    if (kind === 'workspace') {
      const res = await syncDownloadFromCloud();
      return {
        kind,
        ok: res.errors.length === 0,
        detail: `${res.downloaded.length} downloaded, ${res.skipped.length} up to date`,
        error: res.errors.join('; ') || undefined,
      };
    }

    if (kind === 'agents') {
      const cloud = await pullSnapshot<unknown>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      await migrateLegacyAgentSchedules();
      if (!Array.isArray(cloud)) throw new Error('Cloud agents snapshot is malformed');
      const legacyGroups = legacyScheduleGroupsFromAgents(cloud);
      const sanitizedCloud = cloud.map(stripLegacyAgentScheduleFields);
      let added = 0;
      let updated = 0;
      // Establish every referenced agent before creating its Routine so a
      // partial pull cannot leave an orphan. The cloud snapshot remains the
      // durable migration source, and content-derived ids make retries safe.
      await mutateAgents((local) => {
        const merged = mergeAgents(local, sanitizedCloud);
        added = merged.added;
        updated = merged.updated;
        local.splice(0, local.length, ...merged.merged);
      });
      const migration = await migrateLegacyScheduleGroups(legacyGroups, await loadAgents());
      const migrationDetail = legacyGroups.length > 0
        ? `; legacy Automations: ${migration.created} created, ${migration.existing} already present, ${migration.invalid} need review, ${migration.skipped} skipped`
        : '';
      return { kind, ok: true, detail: `${added} added, ${updated} updated from cloud${migrationDetail}` };
    }

    if (kind === 'automations') {
      const cloud = await pullSnapshot<unknown>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      await migrateLegacyAgentSchedules();
      const agents = await loadAgents();
      if (Array.isArray(cloud)) {
        const migration = await migrateLegacyScheduleGroups(legacyScheduleGroupsFromSnapshot(cloud), agents);
        return {
          kind,
          ok: true,
          detail: `Legacy Automations migrated: ${migration.created} created, ${migration.existing} already present, ${migration.invalid} need review, ${migration.skipped} skipped`,
        };
      }
      const snapshot = automationSnapshotFromUnknown(cloud);
      const applied = await applyRoutineSnapshots(snapshot.routines, agents);
      return {
        kind,
        ok: true,
        detail: `${applied.created} created, ${applied.updated} updated, ${applied.unchanged} already current, ${applied.skipped} skipped`,
      };
    }

    if (kind === 'board') {
      const cloud = await pullSnapshot<unknown>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      const snapshot = boardSnapshotFromUnknown(cloud);
      const applied = await mergeBoardCloudTasks(snapshot.tasks);
      return {
        kind,
        ok: true,
        detail: `${applied.added} added, ${applied.updated} updated, ${applied.unchanged} already current, ${applied.skipped} skipped with active work`,
      };
    }

    if (kind === 'projects') {
      const cloud = await pullSnapshot<Array<{ id: string; name: string; description?: string; updatedAt?: string; messages?: unknown[] }>>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      const local = await listProjects();
      const byId = new Map(local.map((p) => [p.id, p]));
      let added = 0;
      let updated = 0;
      for (const p of cloud) {
        const existing = byId.get(p.id);
        if (!existing) {
          const created = await createProject(p.name, p.description || '');
          await updateProject(created.id, { name: p.name, description: p.description });
          added++;
        } else if (newer(p.updatedAt, existing.updatedAt)) {
          await updateProject(p.id, { name: p.name, description: p.description });
          updated++;
        }
      }
      return { kind, ok: true, detail: `${added} added, ${updated} updated from cloud` };
    }

    if (kind === 'chats') {
      const cloud = await pullSnapshot<ChatSession[]>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      const local = await listChatSessions({ includeArchived: true });
      const byId = new Map(local.map((s) => [s.id, s]));
      let added = 0;
      let updated = 0;
      const toPatch = (s: ChatSession): Partial<Omit<ChatSession, 'id' | 'createdAt'>> => {
        const clone: Record<string, unknown> = { ...s };
        delete clone.id;
        delete clone.createdAt;
        return clone as Partial<Omit<ChatSession, 'id' | 'createdAt'>>;
      };
      for (const s of cloud) {
        const existing = byId.get(s.id);
        if (!existing) {
          const created = await createChatSession({ title: s.title });
          await updateChatSession(created.id, toPatch(s));
          added++;
        } else if (newer(s.updatedAt, existing.updatedAt)) {
          await updateChatSession(s.id, toPatch(s));
          updated++;
        }
      }
      return { kind, ok: true, detail: `${added} added, ${updated} updated from cloud` };
    }

    if (kind === 'models') {
      const cloud = await pullSnapshot<{ localGrokEnabled?: boolean; localGrokBaseUrl?: string; defaultGrokModel?: string }>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      const cfg = await loadConfig();
      if (!cfg.localGrokEnabled && !cloud.localGrokEnabled) {
        return { kind, ok: true, detail: 'Skipped — no local model in use' };
      }
      await saveConfig({
        localGrokEnabled: cloud.localGrokEnabled,
        localGrokBaseUrl: cloud.localGrokBaseUrl,
        defaultGrokModel: cloud.defaultGrokModel || cfg.defaultGrokModel,
      });
      return { kind, ok: true, detail: 'Local model settings applied from cloud' };
    }

    return { kind, ok: false, detail: '', error: `Unknown sync kind: ${kind}` };
  } catch (e: unknown) {
    return { kind, ok: false, detail: '', error: e instanceof Error ? e.message : 'Sync failed' };
  }
}

export interface SyncOverview {
  hasCloudAuth: boolean;
  counts: Record<SyncKind, number>;
}

export async function getSyncOverview(): Promise<SyncOverview> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  const agents = await loadAgents();
  const projects = await listProjects();
  const chats = await listChatSessions({ includeArchived: true });
  const board = await listBoardCloudTasks();
  const { listGlobalUploadFiles } = await import('./workspace');
  const uploads = await listGlobalUploadFiles().catch(() => []);
  return {
    hasCloudAuth: auth.hasCloudAuth,
    counts: {
      agents: agents.length,
      automations: listRoutines({ limit: 1 }).total,
      projects: projects.length,
      board: board.length,
      chats: chats.length,
      workspace: uploads.length,
      models: cfg.localGrokEnabled ? 1 : 0,
    },
  };
}
