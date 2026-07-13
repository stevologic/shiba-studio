// User-created skills — stored in data/custom-skills.json and merged with the
// built-in SKILL_PRESETS everywhere skills are listed or injected into prompts.

import { randomUUID } from 'crypto';
import path from 'path';
import { dataDir } from './data-paths';
import { SKILL_CATEGORIES, SKILL_PRESETS, type SkillPreset } from './skills-catalog';
import { recordManagedStorageIssue } from './managed-storage-quarantine';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

export interface CustomSkill extends SkillPreset {
  custom: true;
  createdAt: string;
  updatedAt: string;
}

const storeFile = () => path.join(dataDir(), 'custom-skills.json');

const customSkillsLockGlobal = globalThis as typeof globalThis & {
  __shibaCustomSkillsChain?: Promise<unknown>;
};

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = customSkillsLockGlobal.__shibaCustomSkillsChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  customSkillsLockGlobal.__shibaCustomSkillsChain = run.then(() => undefined, () => undefined);
  return run;
}

async function loadStoreRawUnlocked(): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8');
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('Invalid custom skills store: expected a JSON array');
    return list;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return [];
  }
}

async function saveStoreUnlocked(skills: CustomSkill[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const target = storeFile();
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(skills, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

interface CustomSkillStoreIntegrityReport {
  skills: CustomSkill[];
  entriesQuarantined: number;
}

/**
 * Keep every catalog id single-owned. Custom ids are normally generated from
 * a slug and therefore cannot overlap `pack:*` ids, but older/manual JSON can.
 * Preserve ambiguous records in lost+found before removing them from the live
 * catalog; an agent assignment then continues to resolve to the other owner.
 */
async function reconcileCustomSkillStoreUnlocked(): Promise<CustomSkillStoreIntegrityReport> {
  const raw = await loadStoreRawUnlocked();
  const reservedIds = new Set(SKILL_PRESETS.map((skill) => skill.id));

  const skills: CustomSkill[] = [];
  const seen = new Set<string>();
  let entriesQuarantined = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    const candidate = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Partial<CustomSkill>
      : null;
    const id = typeof candidate?.id === 'string' ? candidate.id : '';
    let reason = '';
    if (id.startsWith('pack:')) reason = 'reserved_pack_namespace';
    else if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) reason = 'invalid_id';
    else if (reservedIds.has(id)) reason = 'catalog_id_collision';
    else if (seen.has(id)) reason = 'duplicate_custom_id';
    if (reason) {
      await recordManagedStorageIssue('ambiguous_custom_skill_owner', {
        reason,
        index,
        record: value,
      });
      entriesQuarantined += 1;
      continue;
    }
    seen.add(id);
    skills.push(candidate as CustomSkill);
  }
  if (entriesQuarantined > 0) await saveStoreUnlocked(skills);
  return { skills, entriesQuarantined };
}

async function loadStoreUnlocked(): Promise<CustomSkill[]> {
  return (await reconcileCustomSkillStoreUnlocked()).skills;
}

export async function listCustomSkills(): Promise<CustomSkill[]> {
  return withStoreLock(loadStoreUnlocked);
}

/** Built-in presets + user-created skills — the full catalog for prompts and pickers. */
export async function getAllSkillPresets(): Promise<SkillPreset[]> {
  return withStoreLock(async () => {
    const custom = await loadStoreUnlocked();
    const { listActiveCapabilityPackSkills } = await import('./capability-packs');
    const packs = await listActiveCapabilityPackSkills();
    return [...SKILL_PRESETS, ...custom, ...packs];
  });
}

function normalizeOwnedSkillIds(
  value: unknown,
  validIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((id) => id.trim()).filter((id) => id && validIds.has(id)))];
}

function skillIdsChanged(current: unknown, next: readonly string[]): boolean {
  if (!Array.isArray(current) || current.length !== next.length) return true;
  return current.some((id, index) => id !== next[index]);
}

export interface AgentSkillReferenceIntegrityReport {
  agentsUpdated: number;
  referencesDetached: number;
}

/**
 * Remove agent skill ids whose catalog owner no longer exists. Catalog
 * mutations and this repair use the same custom-store -> agent-store lock
 * order, preventing a newly-created valid skill from being mistaken as stale.
 */
export async function reconcileAgentSkillReferences(): Promise<AgentSkillReferenceIntegrityReport> {
  return withStoreLock(async () => {
    const custom = await loadStoreUnlocked();
    const { listActiveCapabilityPackSkills } = await import('./capability-packs');
    const packs = await listActiveCapabilityPackSkills();
    const validIds = new Set([...SKILL_PRESETS, ...custom, ...packs].map((skill) => skill.id));
    const { loadAgents, mutateAgents } = await import('./persistence');
    const snapshot = await loadAgents();
    const needsRepair = snapshot.some((agent) =>
      skillIdsChanged(agent.skills, normalizeOwnedSkillIds(agent.skills, validIds)));
    if (!needsRepair) return { agentsUpdated: 0, referencesDetached: 0 };

    return mutateAgents((agents) => {
      let agentsUpdated = 0;
      let referencesDetached = 0;
      for (const agent of agents) {
        const current = Array.isArray(agent.skills) ? agent.skills : [];
        const next = normalizeOwnedSkillIds(current, validIds);
        if (!skillIdsChanged(agent.skills, next)) continue;
        referencesDetached += Math.max(0, current.length - next.length);
        agent.skills = next;
        agent.updatedAt = new Date().toISOString();
        agentsUpdated += 1;
      }
      return { agentsUpdated, referencesDetached };
    });
  });
}

async function detachSkillFromAgents(id: string): Promise<number> {
  const { loadAgents, mutateAgents } = await import('./persistence');
  if (!(await loadAgents()).some((agent) => agent.skills?.includes(id))) return 0;
  return mutateAgents((agents) => {
    let detached = 0;
    for (const agent of agents) {
      if (!agent.skills?.includes(id)) continue;
      const next = agent.skills.filter((skillId) => skillId !== id);
      detached += agent.skills.length - next.length;
      agent.skills = next;
      agent.updatedAt = new Date().toISOString();
    }
    return detached;
  });
}

async function hasAnotherCatalogOwner(id: string, remainingCustom: readonly CustomSkill[]): Promise<boolean> {
  if (remainingCustom.some((skill) => skill.id === id) || SKILL_PRESETS.some((skill) => skill.id === id)) {
    return true;
  }
  const { listActiveCapabilityPackSkills } = await import('./capability-packs');
  return (await listActiveCapabilityPackSkills()).some((skill) => skill.id === id);
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function validateFields(input: Partial<SkillPreset>): string | null {
  if (input.name !== undefined && !String(input.name).trim()) return 'Name is required';
  if (input.category !== undefined && !SKILL_CATEGORIES.includes(input.category as typeof SKILL_CATEGORIES[number])) {
    return `Category must be one of: ${SKILL_CATEGORIES.join(', ')}`;
  }
  return null;
}

export async function createCustomSkill(input: {
  name: string;
  description?: string;
  category: SkillPreset['category'];
  promptHint?: string;
}): Promise<CustomSkill> {
  const err = validateFields(input);
  if (err) throw new Error(err);
  return withStoreLock(async () => {
    const custom = await loadStoreUnlocked();
    const taken = new Set([...SKILL_PRESETS.map((s) => s.id), ...custom.map((s) => s.id)]);
    const base = slugify(input.name) || 'skill';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const now = new Date().toISOString();
    const skill: CustomSkill = {
      id,
      name: input.name.trim(),
      description: (input.description || '').trim(),
      category: input.category,
      promptHint: (input.promptHint || '').trim(),
      custom: true,
      createdAt: now,
      updatedAt: now,
    };
    custom.push(skill);
    await saveStoreUnlocked(custom);
    return skill;
  });
}

export async function updateCustomSkill(
  id: string,
  patch: Partial<Pick<SkillPreset, 'name' | 'description' | 'category' | 'promptHint'>>,
): Promise<CustomSkill> {
  const err = validateFields(patch);
  if (err) throw new Error(err);
  return withStoreLock(async () => {
    const custom = await loadStoreUnlocked();
    const idx = custom.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('Custom skill not found');
    custom[idx] = {
      ...custom[idx],
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.promptHint !== undefined ? { promptHint: patch.promptHint.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    await saveStoreUnlocked(custom);
    return custom[idx];
  });
}

export async function deleteCustomSkill(id: string): Promise<void> {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error('Custom skill id is required');
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  await withIntegrityMutation(`custom skill deletion:${normalizedId}`, () => withStoreLock(async () => {
    const custom = await loadStoreUnlocked();
    const remaining = custom.filter((skill) => skill.id !== normalizedId);
    // Detach first only when this record is the final catalog owner. A
    // legacy/custom collision with a built-in or active pack must leave the
    // still-valid agent assignment attached to that surviving owner.
    if (!(await hasAnotherCatalogOwner(normalizedId, remaining))) {
      await detachSkillFromAgents(normalizedId);
    }
    if (remaining.length !== custom.length) await saveStoreUnlocked(remaining);
  }));
}
