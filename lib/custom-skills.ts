// User-created skills — stored in data/custom-skills.json and merged with the
// built-in SKILL_PRESETS everywhere skills are listed or injected into prompts.

import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { SKILL_CATEGORIES, SKILL_PRESETS, type SkillPreset } from './skills-catalog';

export interface CustomSkill extends SkillPreset {
  custom: true;
  createdAt: string;
  updatedAt: string;
}

const storeFile = () => path.join(dataDir(), 'custom-skills.json');

async function loadStore(): Promise<CustomSkill[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveStore(skills: CustomSkill[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(storeFile(), JSON.stringify(skills, null, 2));
}

export async function listCustomSkills(): Promise<CustomSkill[]> {
  return loadStore();
}

/** Built-in presets + user-created skills — the full catalog for prompts and pickers. */
export async function getAllSkillPresets(): Promise<SkillPreset[]> {
  const custom = await loadStore();
  return [...SKILL_PRESETS, ...custom];
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
  const custom = await loadStore();
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
  await saveStore(custom);
  return skill;
}

export async function updateCustomSkill(
  id: string,
  patch: Partial<Pick<SkillPreset, 'name' | 'description' | 'category' | 'promptHint'>>,
): Promise<CustomSkill> {
  const err = validateFields(patch);
  if (err) throw new Error(err);
  const custom = await loadStore();
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
  await saveStore(custom);
  return custom[idx];
}

export async function deleteCustomSkill(id: string): Promise<void> {
  const custom = await loadStore();
  await saveStore(custom.filter((s) => s.id !== id));
}
