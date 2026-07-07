import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import {
  buildProjectContextHeader,
  normalizeProject,
  resolveProjectWorkspace,
  type Project,
  type ProjectChatMessage,
  type ProjectFileMeta,
} from './project-types';

export type { Project, ProjectChatMessage, ProjectFileMeta } from './project-types';
export {
  normalizeProject,
  resolveProjectWorkspace,
  buildProjectContextHeader,
  buildProjectAgentPrompt,
} from './project-types';

import { readFileSmart, sanitizeUploadName, sha256Checksum, recordUploadMeta, removeUploadMeta } from './workspace';

const DATA_DIR = dataDir();
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const PROJECT_FILES_ROOT = path.join(DATA_DIR, 'project-files');
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PROJECT_FILES_ROOT, { recursive: true });
}

export function projectFilesDir(projectId: string): string {
  return path.join(PROJECT_FILES_ROOT, projectId, 'files');
}

async function loadStore(): Promise<Project[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(PROJECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];
    return list.map((p: Project) => normalizeProject(p));
  } catch {
    return [];
  }
}

async function saveStore(projects: Project[]) {
  await ensureData();
  await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects }, null, 2));
}

export async function listProjects(): Promise<Project[]> {
  const projects = await loadStore();
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await loadStore();
  return projects.find((p) => p.id === id) || null;
}

export async function createProject(name: string, description = ''): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = normalizeProject({
    id: uuidv4(),
    name: name.trim() || 'Untitled Project',
    description: description.trim(),
    instructions: '',
    workspacePath: '',
    defaultAgentId: '',
    files: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  await fs.mkdir(projectFilesDir(project.id), { recursive: true });
  const projects = await loadStore();
  projects.push(project);
  await saveStore(projects);
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'workspacePath' | 'defaultAgentId'>>,
): Promise<Project> {
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Project not found');
  projects[idx] = {
    ...projects[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await saveStore(projects);
  return projects[idx];
}

export async function deleteProject(id: string): Promise<void> {
  const projects = await loadStore();
  await saveStore(projects.filter((p) => p.id !== id));
  await fs.rm(path.join(PROJECT_FILES_ROOT, id), { recursive: true, force: true }).catch(() => {});
}

export async function saveProjectMessages(id: string, messages: ProjectChatMessage[]): Promise<Project> {
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Project not found');
  projects[idx].messages = messages;
  projects[idx].updatedAt = new Date().toISOString();
  await saveStore(projects);
  return projects[idx];
}

export async function addProjectFile(
  projectId: string,
  filename: string,
  content: Buffer,
  mimeType?: string,
): Promise<ProjectFileMeta> {
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) throw new Error('Project not found');

  const dir = projectFilesDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const storedName = sanitizeUploadName(filename);
  const dest = path.join(dir, storedName);
  await fs.writeFile(dest, content);

  const checksum = sha256Checksum(content);
  const uploadedAt = new Date().toISOString();
  const metaKey = `project:${projectId}:${storedName}`;
  await recordUploadMeta(metaKey, checksum, uploadedAt);

  const fileMeta: ProjectFileMeta = {
    id: uuidv4(),
    name: filename,
    storedName,
    size: content.length,
    uploadedAt,
    checksum,
    mimeType,
  };

  const existing = projects[idx].files.findIndex((f) => f.storedName === storedName);
  if (existing >= 0) projects[idx].files[existing] = fileMeta;
  else projects[idx].files.push(fileMeta);

  projects[idx].updatedAt = uploadedAt;
  await saveStore(projects);
  return fileMeta;
}

export async function deleteProjectFile(projectId: string, fileId: string): Promise<Project> {
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) throw new Error('Project not found');

  const fileIdx = projects[idx].files.findIndex((f) => f.id === fileId);
  if (fileIdx < 0) throw new Error('File not found');

  const file = projects[idx].files[fileIdx];
  const filePath = path.join(projectFilesDir(projectId), file.storedName);
  await fs.rm(filePath, { force: true }).catch(() => {});
  await removeUploadMeta(`project:${projectId}:${file.storedName}`);

  projects[idx].files.splice(fileIdx, 1);
  projects[idx].updatedAt = new Date().toISOString();
  await saveStore(projects);
  return projects[idx];
}

export async function readProjectFileText(projectId: string, storedName: string): Promise<string> {
  const filePath = path.join(projectFilesDir(projectId), storedName);
  const result = await readFileSmart(filePath);
  return result.content;
}

export async function buildProjectChatContext(project: Project, defaultWorkspace?: string): Promise<string> {
  const workspaceResolved = defaultWorkspace
    ? resolveProjectWorkspace(project, defaultWorkspace)
    : project.workspacePath?.trim();
  const lines: string[] = [
    'You are assisting within a GrokDesk project.',
    buildProjectContextHeader(project, workspaceResolved),
  ];

  if (project.files.length === 0) {
    lines.push('No files uploaded to this project yet.');
  } else {
    lines.push('Project uploads (available for this entire conversation):');
    for (const f of project.files) {
      lines.push(`- ${f.name} (${Math.round(f.size / 1024)} KB, uploaded ${new Date(f.uploadedAt).toLocaleString()})`);
    }

    const textLike = project.files.filter((f) =>
      /\.(md|txt|json|csv|ts|tsx|js|jsx|py|html|xml|yaml|yml|toml)$/i.test(f.name),
    );
    if (textLike.length) {
      lines.push('', 'Excerpts from text project files:');
      for (const f of textLike.slice(0, 6)) {
        try {
          const text = await readProjectFileText(project.id, f.storedName);
          const excerpt = text.slice(0, 3500);
          lines.push(`\n--- ${f.name} ---\n${excerpt}${text.length > 3500 ? '\n…(truncated)' : ''}`);
        } catch {
          /* skip */
        }
      }
    }
  }

  lines.push('', 'Ground answers in these project materials when relevant. New uploads during chat are added to this project.');
  return lines.join('\n');
}