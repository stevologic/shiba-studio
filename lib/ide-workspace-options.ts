import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectRoot } from './data-paths';
import type {
  IdeWorkspaceOption,
  IdeWorkspaceOptionsResponse,
} from './ide-workspace-options-types';
import {
  IdeWorkspaceError,
  resolveIdeWorkspaceRoot,
} from './ide-workspace';
import { loadAgents, loadConfig } from './persistence';
import { listProjects, resolveProjectWorkspace } from './projects';
import type { Project } from './project-types';
import type { Agent } from './types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 8_000;
const GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

type WorkspaceProject = Pick<Project, 'id' | 'name' | 'workspacePath'>;
type WorkspaceAgent = Pick<Agent, 'id' | 'name' | 'workspace'>;

export interface DiscoverIdeWorkspaceOptionsInput {
  /**
   * Dependency overrides are used by the isolated verifier. Production callers
   * omit them and read the normal config/project stores.
   */
  configuredDefaultWorkspace?: string;
  projects?: readonly WorkspaceProject[];
  agents?: readonly WorkspaceAgent[];
  root?: string;
  gitCommand?: string;
}

interface InspectedDirectory {
  path: string;
  available: boolean;
  reason?: 'invalid' | 'missing' | 'not-directory' | 'unavailable';
}

interface GitWorktreeRecord {
  path: string;
  branch?: string;
}

interface WorkspaceBase {
  path: string;
  isDefault: boolean;
  projects: WorkspaceProject[];
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function configuredAbsolutePath(value: string, root: string): string {
  const requested = value.trim();
  if (!requested || requested.includes('\0')) return requested || root;
  try {
    return path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, requested);
  } catch {
    return requested;
  }
}

async function inspectDirectory(value: string, root: string): Promise<InspectedDirectory> {
  const resolved = configuredAbsolutePath(value, root);
  if (!resolved || resolved.includes('\0') || !path.isAbsolute(resolved)) {
    return { path: resolved || value, available: false, reason: 'invalid' };
  }

  try {
    return { path: await resolveIdeWorkspaceRoot(resolved), available: true };
  } catch (error) {
    if (error instanceof IdeWorkspaceError) {
      if (error.code === 'WORKSPACE_NOT_FOUND' || error.code === 'PATH_NOT_FOUND') {
        return { path: resolved, available: false, reason: 'missing' };
      }
      if (error.code === 'NOT_A_DIRECTORY') {
        return { path: resolved, available: false, reason: 'not-directory' };
      }
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: resolved, available: false, reason: 'missing' };
    }
    return { path: resolved, available: false, reason: 'unavailable' };
  }
}

async function canonicalRealWorktree(value: string): Promise<string | null> {
  try {
    const resolved = path.resolve(value);
    const stat = await fs.lstat(resolved);
    // A linked directory is valid, but a symlink/junction at the worktree root
    // must not make an arbitrary target selectable as a Git-owned worktree.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const real = await fs.realpath(resolved);
    const realStat = await fs.stat(real);
    return realStat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function unavailableDetail(kind: 'default' | 'project', reason: InspectedDirectory['reason']): string {
  const subject = kind === 'default' ? 'Default workspace' : 'Project workspace';
  if (reason === 'missing') return `${subject} folder does not exist.`;
  if (reason === 'not-directory') return `${subject} path is not a folder.`;
  if (reason === 'invalid') return `${subject} path is invalid.`;
  return `${subject} folder is not accessible.`;
}

function projectName(project: WorkspaceProject): string {
  return String(project.name || '').trim() || 'Untitled Project';
}

function compareProjects(left: WorkspaceProject, right: WorkspaceProject): number {
  return projectName(left).localeCompare(projectName(right), undefined, { sensitivity: 'base' })
    || String(left.id).localeCompare(String(right.id));
}

function parseGitWorktreePorcelain(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | undefined;

  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current?.path) records.push(current);
      current = { path: field.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('branch ')) {
      const ref = field.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref;
    }
  }
  if (current?.path) records.push(current);
  return records;
}

async function listGitWorktrees(
  basePath: string,
  gitCommand: string,
): Promise<GitWorktreeRecord[]> {
  try {
    const { stdout } = await execFileAsync(
      gitCommand,
      ['worktree', 'list', '--porcelain', '-z'],
      {
        cwd: basePath,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
    return parseGitWorktreePorcelain(String(stdout));
  } catch {
    // A workspace need not be a Git repository, and Git itself is optional.
    return [];
  }
}

function addBase(
  bases: Map<string, WorkspaceBase>,
  inspected: InspectedDirectory,
  source: { isDefault: boolean; project?: WorkspaceProject },
): void {
  if (!inspected.available) return;
  const key = pathKey(inspected.path);
  const current = bases.get(key);
  if (current) {
    current.isDefault ||= source.isDefault;
    if (
      source.project
      && !current.projects.some((project) => project.id === source.project?.id)
    ) {
      current.projects.push(source.project);
    }
    return;
  }
  bases.set(key, {
    path: inspected.path,
    isDefault: source.isDefault,
    projects: source.project ? [source.project] : [],
  });
}

function worktreeId(canonicalPath: string): string {
  return `worktree:${createHash('sha256').update(pathKey(canonicalPath)).digest('hex').slice(0, 20)}`;
}

/**
 * Build the read-only set of roots the IDE can open. Available paths are
 * canonicalized, path aliases are collapsed, and the configured default is
 * retained even when its folder is temporarily unavailable.
 */
export async function discoverIdeWorkspaceOptions(
  input: DiscoverIdeWorkspaceOptionsInput = {},
): Promise<IdeWorkspaceOptionsResponse> {
  const root = path.resolve(input.root || projectRoot());
  const [configuredDefaultWorkspace, loadedProjects, loadedAgents] = await Promise.all([
    input.configuredDefaultWorkspace !== undefined
      ? Promise.resolve(input.configuredDefaultWorkspace)
      : loadConfig().then((config) => config.defaultWorkspace),
    input.projects !== undefined
      ? Promise.resolve([...input.projects])
      : listProjects(),
    input.agents !== undefined
      ? Promise.resolve([...input.agents])
      : loadAgents(),
  ]);
  const projects = [...loadedProjects].sort(compareProjects);
  const configuredDefault = String(configuredDefaultWorkspace || '').trim() || root;
  const inspectedDefault = await inspectDirectory(configuredDefault, root);
  const defaultOption: IdeWorkspaceOption = {
    id: 'default',
    kind: 'default',
    label: 'Default workspace',
    path: inspectedDefault.path,
    available: inspectedDefault.available,
    isDefault: true,
    detail: inspectedDefault.available
      ? (configuredDefaultWorkspace?.trim()
        ? 'Configured default workspace'
        : 'Shiba Studio workspace')
      : unavailableDetail('default', inspectedDefault.reason),
  };

  const options: IdeWorkspaceOption[] = [defaultOption];
  const seenPaths = new Set<string>([pathKey(defaultOption.path)]);
  const bases = new Map<string, WorkspaceBase>();
  const worktreeAgents = new Map<string, WorkspaceAgent>();
  addBase(bases, inspectedDefault, { isDefault: true });

  for (const project of projects) {
    const requestedWorkspace = resolveProjectWorkspace(
      project as Project,
      configuredAbsolutePath(configuredDefault, root),
    );
    const inspected = await inspectDirectory(requestedWorkspace, root);
    addBase(bases, inspected, { isDefault: false, project });

    const key = pathKey(inspected.path);
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    const name = projectName(project);
    options.push({
      id: `project:${String(project.id)}`,
      kind: 'project',
      label: name,
      path: inspected.path,
      available: inspected.available,
      projectId: String(project.id),
      projectName: name,
      detail: inspected.available
        ? 'Project workspace'
        : unavailableDetail('project', inspected.reason),
    });
  }

  for (const agent of loadedAgents) {
    if (!agent.workspace?.useWorktree) continue;
    const requestedWorkspace = String(agent.workspace.path || '').trim() || configuredDefault;
    const inspected = await inspectDirectory(requestedWorkspace, root);
    addBase(bases, inspected, { isDefault: false });
    if (inspected.available) {
      const expectedWorktree = path.join(inspected.path, '.worktrees', String(agent.id));
      worktreeAgents.set(pathKey(expectedWorktree), agent);
    }
  }

  const worktreeOptions: IdeWorkspaceOption[] = [];
  const orderedBases = [...bases.values()].sort((left, right) => (
    Number(right.isDefault) - Number(left.isDefault)
    || left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
  ));
  for (const base of orderedBases) {
    const associatedProject = [...base.projects].sort(compareProjects)[0];
    const records = await listGitWorktrees(base.path, input.gitCommand || 'git');
    for (const record of records) {
      const canonicalPath = await canonicalRealWorktree(record.path);
      if (!canonicalPath) continue;
      const key = pathKey(canonicalPath);
      // `git worktree list` includes the base checkout. It may also include a
      // folder already represented by another project. A path appears once.
      if (key === pathKey(base.path) || seenPaths.has(key)) continue;
      seenPaths.add(key);
      const matchedAgent = worktreeAgents.get(key);
      const matchedAgentName = String(matchedAgent?.name || '').trim();
      const label = matchedAgentName || path.basename(canonicalPath) || record.branch || canonicalPath;
      worktreeOptions.push({
        id: worktreeId(canonicalPath),
        kind: 'worktree',
        label,
        path: canonicalPath,
        available: true,
        basePath: base.path,
        ...(record.branch ? { branch: record.branch } : {}),
        ...(associatedProject ? {
          projectId: String(associatedProject.id),
          projectName: projectName(associatedProject),
        } : {}),
        ...(matchedAgent ? {
          agentId: String(matchedAgent.id),
          agentName: matchedAgentName || String(matchedAgent.id),
        } : {}),
        detail: record.branch ? `Git worktree · ${record.branch}` : 'Detached Git worktree',
      });
    }
  }

  worktreeOptions.sort((left, right) => (
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
    || left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
  ));
  options.push(...worktreeOptions);

  return {
    ok: true,
    defaultWorkspace: defaultOption.path,
    options,
    projectCount: projects.length,
  };
}
