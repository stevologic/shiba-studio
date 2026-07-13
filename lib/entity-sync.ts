// Entity-level cloud sync — push/pull Shiba Studio entities (agents, automations, projects,
// chats, workspace uploads, local-model settings) to/from the xAI cloud file store.
// Each entity kind is serialized as one JSON snapshot file so any Shiba Studio install
// connected to the same xAI account can pull it down.

import { loadAgents, mutateAgents, loadConfig, saveConfig } from './persistence';
import { normalizeAgent, type Agent, type ScheduleEntry } from './types';
import { listProjects, updateProject, createProject } from './projects';
import { listChatSessions, createChatSession, updateChatSession, type ChatSession } from './chat-sessions';
import { syncUploadToCloud, syncDownloadFromCloud } from './cloud-sync';
import { deleteXaiFile, downloadXaiFileContent, listXaiFiles, uploadXaiFile } from './xai-files';
import { resolveCloudBearer } from './xai-oauth';
import { setApiKey } from './grok-client';

export type SyncKind = 'agents' | 'automations' | 'projects' | 'chats' | 'workspace' | 'models';

export const SYNC_KINDS: SyncKind[] = ['agents', 'automations', 'projects', 'chats', 'workspace', 'models'];

export interface SyncKindResult {
  kind: SyncKind;
  ok: boolean;
  detail: string;
  error?: string;
}

const SNAPSHOT_PREFIX = 'shiba-sync-';
// Snapshots pushed before the rebrand still sit in xAI storage under this name.
const LEGACY_SNAPSHOT_PREFIX = 'grokdesk-sync-';

function snapshotName(kind: SyncKind): string {
  return `${SNAPSHOT_PREFIX}${kind}.json`;
}

async function requireCloudAuth(): Promise<void> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) throw new Error('Cloud credentials required (xAI API key or OAuth with X)');
  setApiKey(auth.token);
}

/** Upload a JSON snapshot, replacing older snapshots of the same kind to avoid clutter. */
async function pushSnapshot(kind: SyncKind, payload: unknown): Promise<string> {
  const name = snapshotName(kind);
  const body = Buffer.from(JSON.stringify({ kind, exportedAt: new Date().toISOString(), payload }, null, 2));
  const meta = await uploadXaiFile(name, body);
  try {
    const stale = (await listXaiFiles()).filter((f) => f.filename === name && f.id !== meta.id);
    await Promise.allSettled(stale.map((f) => deleteXaiFile(f.id)));
  } catch {
    /* stale cleanup is best-effort */
  }
  return meta.id;
}

async function pullSnapshot<T>(kind: SyncKind): Promise<T | null> {
  const all = await listXaiFiles();
  const latestNamed = (name: string) =>
    all.filter((f) => f.filename === name).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  // Prefer current snapshots; fall back to pre-rebrand ones so a fresh install
  // can still pull entities pushed by an older version.
  const files = latestNamed(snapshotName(kind)).length
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

/** Merge cloud agents into local by id — newest updatedAt wins; unseen agents are added. */
function mergeAgents(local: Agent[], cloud: Agent[]): { merged: Agent[]; added: number; updated: number } {
  const byId = new Map(local.map((a) => [a.id, a]));
  let added = 0;
  let updated = 0;
  for (const raw of cloud) {
    const incoming = normalizeAgent(raw);
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
    await requireCloudAuth();

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
      const agents = await loadAgents();
      await pushSnapshot(kind, agents);
      return { kind, ok: true, detail: `${agents.length} agent(s) pushed` };
    }

    if (kind === 'automations') {
      const agents = await loadAgents();
      const automations = agents
        .filter((a) => (a.schedules || []).length > 0)
        .map((a) => ({ agentId: a.id, agentName: a.name, schedules: a.schedules }));
      await pushSnapshot(kind, automations);
      const count = automations.reduce((n, a) => n + a.schedules.length, 0);
      return { kind, ok: true, detail: `${count} schedule(s) across ${automations.length} agent(s) pushed` };
    }

    if (kind === 'projects') {
      const projects = await listProjects();
      await pushSnapshot(kind, projects);
      return { kind, ok: true, detail: `${projects.length} project(s) pushed (metadata + chat history)` };
    }

    if (kind === 'chats') {
      const sessions = await listChatSessions({ includeArchived: true });
      await pushSnapshot(kind, sessions);
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
      });
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
      const cloud = await pullSnapshot<Agent[]>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      let added = 0;
      let updated = 0;
      await mutateAgents((local) => {
        const merged = mergeAgents(local, cloud);
        added = merged.added;
        updated = merged.updated;
        local.splice(0, local.length, ...merged.merged);
      });
      return { kind, ok: true, detail: `${added} added, ${updated} updated from cloud` };
    }

    if (kind === 'automations') {
      const cloud = await pullSnapshot<Array<{ agentId: string; schedules: ScheduleEntry[] }>>(kind);
      if (!cloud) return { kind, ok: true, detail: 'No cloud snapshot yet — push first' };
      let applied = 0;
      await mutateAgents((agents) => {
        for (const entry of cloud) {
          const agent = agents.find((a) => a.id === entry.agentId);
          if (agent && Array.isArray(entry.schedules)) {
            agent.schedules = entry.schedules;
            applied++;
          }
        }
      });
      return { kind, ok: true, detail: `Schedules applied to ${applied} agent(s)` };
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
  const { listGlobalUploadFiles } = await import('./workspace');
  const uploads = await listGlobalUploadFiles().catch(() => []);
  return {
    hasCloudAuth: auth.hasCloudAuth,
    counts: {
      agents: agents.length,
      automations: agents.reduce((n, a) => n + (a.schedules || []).filter((s) => s.enabled).length, 0),
      projects: projects.length,
      chats: chats.length,
      workspace: uploads.length,
      models: cfg.localGrokEnabled ? 1 : 0,
    },
  };
}
