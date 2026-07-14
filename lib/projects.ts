import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import { deleteContextScope, indexProjectContext } from './context-engine';
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

import {
  readFileSmart,
  sanitizeUploadName,
  sha256Checksum,
  removeProjectUploadMetadata,
  removeUploadMeta,
} from './workspace';
import { quarantineManagedPath, recordManagedStorageIssue } from './managed-storage-quarantine';
import { ownershipStoreFencePath, withStoreFileLock } from './store-file-lock';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const DATA_DIR = dataDir();
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const PROJECT_FILES_ROOT = path.join(DATA_DIR, 'project-files');
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

function withProjectsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  return withStoreFileLock(
    ownershipStoreFencePath(DATA_DIR),
    () => withStoreFileLock(PROJECTS_FILE, fn),
  );
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PROJECT_FILES_ROOT, { recursive: true });
}

export function projectFilesDir(projectId: string): string {
  const id = projectId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') {
    throw new Error('Invalid project id');
  }
  const root = path.resolve(PROJECT_FILES_ROOT);
  const projectRoot = path.resolve(root, id);
  if (path.dirname(projectRoot) !== root) throw new Error('Project path escapes its data directory');
  return path.join(projectRoot, 'files');
}

function projectStoredFilePath(projectId: string, storedName: string): string {
  const name = String(storedName || '');
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !name
    || name !== path.basename(name)
    || name === '.'
    || name === '..'
    || name.endsWith('.')
    || name.endsWith(' ')
    || windowsReserved.test(name)
  ) {
    throw new Error('Invalid stored project filename');
  }
  const root = path.resolve(projectFilesDir(projectId));
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) throw new Error('Project file path escapes its data directory');
  return target;
}

async function loadStore(): Promise<Project[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(PROJECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.projects)) {
      throw new Error('Invalid projects store: expected an object with a projects array');
    }
    const list = parsed.projects as unknown[];
    if (list.some((project) => !project || typeof project !== 'object' || Array.isArray(project))) {
      throw new Error('Invalid projects store: every project must be an object');
    }
    return list.map((project) => normalizeProject(project as Project));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveStore(projects: Project[]) {
  await ensureData();
  const temporary = `${PROJECTS_FILE}.${process.pid}.${uuidv4()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, PROJECTS_FILE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function listProjects(): Promise<Project[]> {
  const projects = await loadStore();
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Count-only path for navigation badges; no sort or response-sized copy. */
export async function countProjects(): Promise<number> {
  return (await loadStore()).length;
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await loadStore();
  return projects.find((p) => p.id === id) || null;
}

export async function createProject(name: string, description = ''): Promise<Project> {
  return withProjectsWriteLock(async () => {
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
  const projects = await loadStore();
  projects.push(project);
  await saveStore(projects);
  indexProjectContext(project);
  return project;
  });
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'workspacePath' | 'defaultAgentId'>>,
): Promise<Project> {
  const mutate = () => withProjectsWriteLock(async () => {
    const projects = await loadStore();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Project not found');
    const mutablePatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(mutablePatch, 'workspacePath')) {
      const requested = mutablePatch.workspacePath?.trim() || '';
      if (requested) {
        const resolved = path.resolve(/* turbopackIgnore: true */ requested);
        const stat = await fs.lstat(resolved).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
          throw new Error('Project workspace must be an existing real directory');
        }
        mutablePatch.workspacePath = resolved;
      } else {
        mutablePatch.workspacePath = '';
      }
    }
    projects[idx] = {
      ...projects[idx],
      ...mutablePatch,
      updatedAt: new Date().toISOString(),
    };
    await saveStore(projects);
    indexProjectContext(projects[idx]);
    return projects[idx];
  });
  if (!Object.prototype.hasOwnProperty.call(patch, 'workspacePath')) return mutate();

  const { withIntegrityMutation } = await import('./integrity-coordinator');
  const { result } = await withIntegrityMutation(
    `project workspace update:${id}`,
    mutate,
    { includeWorktrees: true, includeExternalCleanup: false },
  );
  return result;
}

export async function deleteProject(id: string): Promise<void> {
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  await withIntegrityMutation(`project deletion:${id}`, () => withProjectsWriteLock(async () => {
      const projects = await loadStore();
      const project = projects.find((item) => item.id === id);
      if (!project) throw new Error('Project not found');
      projectFilesDir(project.id); // Validate before committing the owner deletion.
      // uploads-meta is a derived cache, but legacy builds stored project rows
      // there. Clear them before committing deletion so a successful delete can
      // never leave cache records without an owner.
      await removeProjectUploadMetadata(project.id);
      await saveStore(projects.filter((item) => item.id !== project.id));
      try { deleteContextScope('project', project.id); }
      catch (error) { console.error('[shiba-studio] deferred deleted-project context cleanup', error); }
      await cleanupDeletedProjectStorage(project).catch((error) => {
        console.error('[shiba-studio] deferred deleted-project storage cleanup', error);
      });
    }), { includeWorktrees: true, includeExternalCleanup: false });
}

/** Clear a dangling default without overwriting a concurrent project edit. */
export async function clearProjectDefaultAgentIfMatches(
  id: string,
  expectedAgentId: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  return withProjectsWriteLock(async () => {
    const projects = await loadStore();
    const idx = projects.findIndex((project) => project.id === id);
    if (idx < 0) return false;
    const project = projects[idx];
    if (project.defaultAgentId !== expectedAgentId || project.updatedAt !== expectedUpdatedAt) return false;
    project.defaultAgentId = '';
    project.updatedAt = new Date().toISOString();
    await saveStore(projects);
    indexProjectContext(project);
    return true;
  });
}

/** Clear a project workspace after its app-owned worktree was reclaimed,
 * without overwriting a concurrent project edit. */
export async function clearProjectWorkspaceIfMatches(
  id: string,
  expectedWorkspacePath: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  return withProjectsWriteLock(async () => {
    const projects = await loadStore();
    const idx = projects.findIndex((project) => project.id === id);
    if (idx < 0) return false;
    const project = projects[idx];
    const current = project.workspacePath?.trim() || '';
    const expected = expectedWorkspacePath.trim();
    const same = current && expected && (
      process.platform === 'win32'
        ? path.resolve(/* turbopackIgnore: true */ current).toLowerCase()
          === path.resolve(/* turbopackIgnore: true */ expected).toLowerCase()
        : path.resolve(/* turbopackIgnore: true */ current)
          === path.resolve(/* turbopackIgnore: true */ expected)
    );
    if (!same || project.updatedAt !== expectedUpdatedAt) return false;
    project.workspacePath = '';
    project.updatedAt = new Date().toISOString();
    await saveStore(projects);
    indexProjectContext(project);
    return true;
  });
}

export async function saveProjectMessages(id: string, messages: ProjectChatMessage[]): Promise<Project> {
  return withProjectsWriteLock(async () => {
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Project not found');
  projects[idx].messages = messages;
  projects[idx].updatedAt = new Date().toISOString();
  await saveStore(projects);
  indexProjectContext(projects[idx]);
  return projects[idx];
  });
}

export async function addProjectFile(
  projectId: string,
  filename: string,
  content: Buffer,
  mimeType?: string,
): Promise<ProjectFileMeta> {
  return withProjectsWriteLock(async () => {
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) throw new Error('Project not found');

  const dir = projectFilesDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const storedName = sanitizeUploadName(filename);
  const dest = projectStoredFilePath(projectId, storedName);
  const checksum = sha256Checksum(content);
  const uploadedAt = new Date().toISOString();
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
  const operationId = uuidv4();
  const staged = `${dest}.${process.pid}.${operationId}.project-upload.tmp`;
  const previous = `${dest}.${process.pid}.${operationId}.project-upload.rollback`;
  let hadPrevious = false;
  let installed = false;
  let committed = false;
  let rollbackRecovered = false;
  await fs.writeFile(staged, content, { flag: 'wx' });
  try {
    try {
      await fs.rename(dest, previous);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(staged, dest);
    installed = true;
    await saveStore(projects);
    committed = true;
  } catch (error) {
    let recoveryError: unknown;
    try {
      if (installed) await fs.rm(dest, { force: true });
      if (hadPrevious) await fs.rename(previous, dest);
      rollbackRecovered = true;
    } catch (caught) {
      recoveryError = caught;
    }
    if (recoveryError) {
      throw new Error(
        `Project upload failed and its previous bytes could not be restored: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
    if (committed || rollbackRecovered || !hadPrevious) {
      await fs.rm(previous, { force: true }).catch(() => undefined);
    }
  }
  try { indexProjectContext(projects[idx]); }
  catch (error) { console.error('[shiba-studio] deferred project context indexing', error); }
  return fileMeta;
  });
}

export async function deleteProjectFile(projectId: string, fileId: string): Promise<Project> {
  return withProjectsWriteLock(async () => {
  const projects = await loadStore();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) throw new Error('Project not found');

  const fileIdx = projects[idx].files.findIndex((f) => f.id === fileId);
  if (fileIdx < 0) throw new Error('File not found');

  const file = projects[idx].files[fileIdx];
  const filePath = projectStoredFilePath(projectId, file.storedName);
  const stagedDelete = `${filePath}.${process.pid}.${uuidv4()}.project-delete.tmp`;
  let staged = false;
  try {
    await fs.rename(filePath, stagedDelete);
    staged = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await removeUploadMeta(`project:${projectId}:${file.storedName}`);
    projects[idx].files.splice(fileIdx, 1);
    projects[idx].updatedAt = new Date().toISOString();
    await saveStore(projects);
  } catch (error) {
    if (staged) {
      try {
        await fs.rename(stagedDelete, filePath);
      } catch (recoveryError) {
        throw new Error(
          `Project file deletion failed and its bytes could not be restored: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  if (staged) await fs.rm(stagedDelete, { force: true }).catch(() => undefined);
  try { indexProjectContext(projects[idx]); }
  catch (error) { console.error('[shiba-studio] deferred project context indexing', error); }
  return projects[idx];
  });
}

export interface ProjectStorageReconcileReport {
  missingReferencesRemoved: number;
  invalidReferencesRemoved: number;
  duplicateReferencesRemoved: number;
  unownedFilesQuarantined: number;
  unownedBytesQuarantined: number;
  youngUnownedFilesRetained: number;
  issueRecordsCreated: number;
  ownershipScanComplete: boolean;
  validProjectFileKeys: string[];
  errors: string[];
}

function storagePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isMissingManagedPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function listManagedProjectEntries(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listManagedProjectEntries(candidate));
    else found.push(candidate); // Includes symlinks without following them.
  }
  return found;
}

async function removeEmptyManagedDirectories(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await removeEmptyManagedDirectories(path.join(directory, entry.name));
  }
  await fs.rmdir(directory).catch(() => undefined);
}

/**
 * Delete bytes explicitly owned by a deleted project, while preserving every
 * unexpected entry. A recursive directory delete would silently erase files
 * left by interrupted uploads or older builds that have no metadata owner.
 */
async function cleanupDeletedProjectStorage(project: Project): Promise<void> {
  const filesDirectory = projectFilesDir(project.id);
  const projectDirectory = path.dirname(filesDirectory);
  const ownedPaths = new Set<string>();
  for (const file of project.files) {
    try {
      ownedPaths.add(storagePathKey(projectStoredFilePath(project.id, file.storedName)));
    } catch {
      // Invalid metadata cannot prove ownership, so its bytes (if any) are
      // handled as unexpected and preserved below.
    }
  }

  for (const candidate of await listManagedProjectEntries(projectDirectory)) {
    if (ownedPaths.has(storagePathKey(candidate))) {
      try {
        await fs.rm(candidate, { force: true });
        continue;
      } catch {
        // If an explicitly owned file cannot be deleted, preserving it is the
        // only safe fallback. The normal reconciler will retry after its grace.
      }
    }
    await quarantineManagedPath(candidate, 'unowned_project_file_on_delete', {
      projectId: project.id,
      projectName: project.name,
      originalRelativePath: path.relative(PROJECT_FILES_ROOT, candidate),
    }).catch(() => {
      // Leave the bytes in place for scheduled reconciliation to retry.
    });
  }
  await removeEmptyManagedDirectories(projectDirectory);
}

/**
 * Reconcile the app-owned project blob tree against projects.json. Missing
 * references are removed with a durable lost+found record. Unowned bytes are
 * moved to lost+found only after a grace period and are never silently erased.
 */
export async function reconcileProjectStorage(input: {
  nowMs?: number;
  minOrphanAgeMs?: number;
} = {}): Promise<ProjectStorageReconcileReport> {
  return withProjectsWriteLock(async () => {
    const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
      ? input.nowMs
      : Date.now();
    const requestedGrace = typeof input.minOrphanAgeMs === 'number' && Number.isFinite(input.minOrphanAgeMs)
      ? input.minOrphanAgeMs
      : 24 * 60 * 60_000;
    const minOrphanAgeMs = Math.max(0, requestedGrace);
    const report: ProjectStorageReconcileReport = {
      missingReferencesRemoved: 0,
      invalidReferencesRemoved: 0,
      duplicateReferencesRemoved: 0,
      unownedFilesQuarantined: 0,
      unownedBytesQuarantined: 0,
      youngUnownedFilesRetained: 0,
      issueRecordsCreated: 0,
      ownershipScanComplete: true,
      validProjectFileKeys: [],
      errors: [],
    };
    // A corrupt authoritative store must fail closed. loadStore throws before
    // any file can be mistaken for an orphan.
    const projects = await loadStore();
    const expectedPaths = new Set<string>();
    const changedProjects: Project[] = [];

    for (const project of projects) {
      const nextFiles: ProjectFileMeta[] = [];
      const seenNames = new Set<string>();
      let changed = false;
      try {
        projectFilesDir(project.id);
      } catch (error) {
        report.ownershipScanComplete = false;
        report.errors.push(`project ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const file of project.files) {
        let filePath: string;
        try {
          filePath = projectStoredFilePath(project.id, file.storedName);
        } catch (error) {
          await recordManagedStorageIssue('invalid_project_file_reference', {
            projectId: project.id,
            file,
            error: error instanceof Error ? error.message : String(error),
          }, nowMs);
          report.invalidReferencesRemoved += 1;
          report.issueRecordsCreated += 1;
          report.ownershipScanComplete = false;
          changed = true;
          continue;
        }
        const nameKey = process.platform === 'win32' ? file.storedName.toLowerCase() : file.storedName;
        if (seenNames.has(nameKey)) {
          await recordManagedStorageIssue('duplicate_project_file_reference', {
            projectId: project.id,
            file,
          }, nowMs);
          report.duplicateReferencesRemoved += 1;
          report.issueRecordsCreated += 1;
          changed = true;
          continue;
        }
        seenNames.add(nameKey);
        let stat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
        try {
          stat = await fs.lstat(filePath);
        } catch (error) {
          if (!isMissingManagedPath(error)) {
            // A permission/I/O failure is not proof that the owner target is
            // missing. Keep the reference and fail closed for this sweep.
            expectedPaths.add(storagePathKey(filePath));
            report.validProjectFileKeys.push(`project:${project.id}:${file.storedName}`);
            nextFiles.push(file);
            report.ownershipScanComplete = false;
            report.errors.push(
              `${path.relative(PROJECT_FILES_ROOT, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
        }
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          await recordManagedStorageIssue('missing_project_file_reference', {
            projectId: project.id,
            file,
            expectedRelativePath: path.relative(DATA_DIR, filePath),
          }, nowMs);
          report.missingReferencesRemoved += 1;
          report.issueRecordsCreated += 1;
          changed = true;
          continue;
        }
        expectedPaths.add(storagePathKey(filePath));
        report.validProjectFileKeys.push(`project:${project.id}:${file.storedName}`);
        nextFiles.push(file);
      }
      if (changed) {
        project.files = nextFiles;
        project.updatedAt = new Date(nowMs).toISOString();
        changedProjects.push(project);
      }
    }

    if (changedProjects.length) {
      await saveStore(projects);
      for (const project of changedProjects) indexProjectContext(project);
    }

    // If any owner path was malformed, defer orphan classification until the
    // repaired owner snapshot has been read cleanly on a later pass.
    if (!report.ownershipScanComplete) return report;

    for (const candidate of await listManagedProjectEntries(PROJECT_FILES_ROOT)) {
      if (expectedPaths.has(storagePathKey(candidate))) continue;
      const stat = await fs.lstat(candidate).catch(() => null);
      if (!stat) continue;
      const ageMs = nowMs - stat.mtimeMs;
      if (!Number.isFinite(ageMs) || ageMs < minOrphanAgeMs) {
        report.youngUnownedFilesRetained += 1;
        continue;
      }
      try {
        await quarantineManagedPath(candidate, 'unowned_project_file', {
          managedRoot: 'project-files',
          originalRelativePath: path.relative(PROJECT_FILES_ROOT, candidate),
        }, nowMs);
        report.unownedFilesQuarantined += 1;
        report.unownedBytesQuarantined += stat.isFile() ? stat.size : 0;
      } catch (error) {
        report.errors.push(`${path.relative(PROJECT_FILES_ROOT, candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  });
}

export async function readProjectFileText(projectId: string, storedName: string): Promise<string> {
  const filePath = projectStoredFilePath(projectId, storedName);
  const result = await readFileSmart(filePath);
  return result.content;
}

export async function buildProjectChatContext(project: Project, defaultWorkspace?: string): Promise<string> {
  const workspaceResolved = defaultWorkspace
    ? resolveProjectWorkspace(project, defaultWorkspace)
    : project.workspacePath?.trim();
  const lines: string[] = [
    'You are assisting within a Shiba Studio project.',
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
