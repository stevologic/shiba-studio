import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkspace, shellExec } from './workspace';

export interface WorkspaceDiffFile {
  path: string;
  status: string;
}

export interface WorkspaceDiffResult {
  isGitRepo: boolean;
  workspace: string;
  files: WorkspaceDiffFile[];
  diff: string;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    try {
      const { stdout, code } = await shellExec('git rev-parse --is-inside-work-tree', dir);
      return code === 0 && stdout.trim() === 'true';
    } catch {
      return false;
    }
  }
}

export async function getWorkspaceDiff(workspaceDir: string): Promise<WorkspaceDiffResult> {
  const workspace = resolveWorkspace(workspaceDir);
  const git = await isGitRepo(workspace);
  if (!git) {
    return { isGitRepo: false, workspace, files: [], diff: '' };
  }

  const statusRes = await shellExec('git status --porcelain', workspace);
  const files: WorkspaceDiffFile[] = [];
  for (const line of statusRes.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const status = trimmed.slice(0, 2).trim() || '?';
    const filePath = trimmed.slice(3).trim();
    if (filePath) files.push({ path: filePath, status });
  }

  const diffRes = await shellExec('git diff HEAD', workspace);
  const untrackedRes = await shellExec('git ls-files --others --exclude-standard', workspace);
  let diff = diffRes.stdout || '';
  for (const untracked of untrackedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (!files.some((f) => f.path === untracked)) {
      files.push({ path: untracked, status: '??' });
    }
    try {
      const full = path.join(workspace, untracked);
      const content = await fs.readFile(full, 'utf8');
      const header = `diff --git a/${untracked} b/${untracked}\nnew file mode 100644\n--- /dev/null\n+++ b/${untracked}\n`;
      const body = content.split('\n').map((line) => `+${line}`).join('\n');
      diff += (diff ? '\n' : '') + header + body;
    } catch {
      /* skip binary or unreadable */
    }
  }

  return { isGitRepo: true, workspace, files, diff };
}

export async function discardWorkspacePaths(workspaceDir: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const workspace = resolveWorkspace(workspaceDir);
  const git = await isGitRepo(workspace);
  if (!git) return { ok: false, error: 'Not a git repository' };
  if (!paths.length) return { ok: false, error: 'No paths specified' };

  for (const rel of paths) {
    const safe = rel.replace(/"/g, '');
    const st = await shellExec(`git status --porcelain -- "${safe}"`, workspace);
    const line = st.stdout.trim();
    if (!line) continue;
    const status = line.slice(0, 2);
    if (status.includes('?')) {
      await shellExec(`git clean -fd -- "${safe}"`, workspace);
    } else {
      await shellExec(`git checkout -- "${safe}"`, workspace);
    }
  }
  return { ok: true };
}