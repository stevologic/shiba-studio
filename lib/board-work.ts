// Collects the delivered work behind a board card: the final answer(s) from
// its linked agent runs plus every file those runs created (fs_write /
// generate_image trace steps), resolved to real paths and stat-checked so the
// UI can link straight to them.

import path from 'path';
import { promises as fs } from 'fs';
import { getBoardTask } from './board';
import { getRun } from './agent-runs-store';
import type { AgentRun, TraceStep } from './types';

export interface WorkFile {
  /** Basename, for display. */
  name: string;
  /** Path as the agent wrote it (usually workspace-relative). */
  relPath: string;
  /** Fully resolved location on this machine. */
  absPath: string;
  exists: boolean;
  size: number;
  mtime: string | null;
  kind: 'image' | 'text' | 'other';
  /** Run that produced it (for trace links). */
  runId: string;
}

export interface WorkRun {
  runId: string;
  agentName: string;
  status: AgentRun['status'];
  completedAt: string | null;
  finalOutput: string;
}

export interface CardWork {
  id: string;
  key: string;
  title: string;
  status: string;
  runs: WorkRun[];
  files: WorkFile[];
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.sh', '.ps1', '.yml', '.yaml', '.toml', '.xml', '.csv', '.log', '.env', '.sql',
]);

function fileKind(p: string): WorkFile['kind'] {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/**
 * Workspace the run executed in. Older runs predate the workspaceSnapshot
 * column — reconstruct from the agent's current workspace config (including
 * its per-agent worktree, which is where useWorktree agents write).
 */
async function runWorkDir(run: AgentRun): Promise<string> {
  if (run.workspaceSnapshot) return run.workspaceSnapshot;
  try {
    const { loadAgents } = await import('./persistence');
    const { resolveWorkspace } = await import('./workspace');
    const agent = (await loadAgents()).find((a) => a.id === run.agentId);
    const base = resolveWorkspace(agent?.workspace?.path || '');
    if (agent?.workspace?.useWorktree) {
      const wt = path.join(base, '.worktrees', agent.id);
      const stat = await fs.stat(wt).catch(() => null);
      if (stat?.isDirectory()) return wt;
    }
    return base;
  } catch {
    return process.cwd();
  }
}

/** Pull created-file paths out of one run's trace. */
function filePathsFromTrace(run: AgentRun, workDir: string): Array<{ relPath: string; absPath: string }> {
  const out: Array<{ relPath: string; absPath: string }> = [];
  for (const step of run.trace || []) {
    const tool = (step as TraceStep).tool;
    if (!tool) continue;
    if (tool.name === 'fs_write') {
      const rel = String((tool.args as { path?: unknown } | undefined)?.path || '').trim();
      if (!rel) continue;
      const abs = path.isAbsolute(rel) ? rel : path.join(workDir, rel);
      out.push({ relPath: rel, absPath: path.normalize(abs) });
    } else if (tool.name === 'generate_image') {
      const p = String((tool.result as { path?: unknown } | undefined)?.path || '').trim();
      if (!p) continue;
      const abs = path.isAbsolute(p) ? p : path.join(workDir, p);
      out.push({ relPath: p, absPath: path.normalize(abs) });
    }
  }
  return out;
}

export async function collectCardWork(idOrKey: string): Promise<CardWork | null> {
  const task = await getBoardTask(idOrKey);
  if (!task) return null;

  const runs: WorkRun[] = [];
  const fileMap = new Map<string, WorkFile>();

  for (const runId of task.runIds) {
    const run = await getRun(runId).catch(() => null);
    if (!run) continue;
    runs.push({
      runId: run.id,
      agentName: run.agentName,
      status: run.status,
      completedAt: run.completedAt || null,
      finalOutput: run.finalOutput || '',
    });
    const workDir = await runWorkDir(run);
    for (const f of filePathsFromTrace(run, workDir)) {
      const stat = await fs.stat(f.absPath).catch(() => null);
      // Later runs win the dedupe — their version of the file is current.
      fileMap.set(f.absPath.toLowerCase(), {
        name: path.basename(f.absPath),
        relPath: f.relPath,
        absPath: f.absPath,
        exists: !!stat?.isFile(),
        size: stat?.isFile() ? stat.size : 0,
        mtime: stat?.isFile() ? stat.mtime.toISOString() : null,
        kind: fileKind(f.absPath),
        runId,
      });
    }
  }

  // Newest run first — its answer is the current one.
  runs.reverse();

  return {
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    runs,
    files: [...fileMap.values()],
  };
}

/**
 * Capability check for the file-serving endpoint: only paths that are actual
 * deliverables of this card may be read through it.
 */
export async function resolveCardDeliverable(idOrKey: string, absPath: string): Promise<WorkFile | null> {
  const work = await collectCardWork(idOrKey);
  if (!work) return null;
  const wanted = path.normalize(absPath).toLowerCase();
  return work.files.find((f) => f.absPath.toLowerCase() === wanted) || null;
}
