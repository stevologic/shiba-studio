// Collects the delivered work behind a board card: the final answer(s) from
// its linked agent runs plus every file those runs created (fs_write /
// generate_image trace steps), resolved to real paths and stat-checked so the
// UI can link straight to them.

import path from 'path';
import { getBoardTask } from './board';
import { getRun, loadRuns } from './agent-runs-store';
import type { Agent, AgentRun, TraceStep } from './types';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

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
  /** One-line gist of a text deliverable (first heading / opening line). */
  preview?: string;
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

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.sh', '.ps1', '.yml', '.yaml', '.toml', '.xml', '.svg', '.csv', '.log', '.env', '.sql',
]);

function fileKind(p: string): WorkFile['kind'] {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/**
 * One-line gist of a text deliverable so the work modal can say what each
 * document IS: prefers the first markdown heading, falls back to the first
 * substantial line.
 */
async function textPreview(absPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(absPath, 'r');
    const buffer = Buffer.allocUnsafe(4000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = head.split('\n').map((l) => l.trim());
    const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
    if (heading) return heading.replace(/^#{1,3}\s+/, '').slice(0, 140);
    const first = lines.find((l) => l.length >= 8 && !/^[-*_=`~\[{(<]/.test(l));
    return first ? first.slice(0, 140) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Workspace the run executed in. Older runs predate the workspaceSnapshot
 * column — reconstruct from the agent's current workspace config (including
 * its per-agent worktree, which is where useWorktree agents write).
 */
async function loadAgentWorkspaceMap(runs: AgentRun[]): Promise<Map<string, Agent>> {
  if (!runs.some((run) => !run.workspaceSnapshot)) return new Map();
  try {
    const { loadAgents } = await import('./persistence');
    return new Map((await loadAgents()).map((agent) => [agent.id, agent]));
  } catch {
    return new Map();
  }
}

async function runWorkDir(run: AgentRun, agentsById: ReadonlyMap<string, Agent>): Promise<string> {
  if (run.workspaceSnapshot) return run.workspaceSnapshot;
  try {
    const { resolveWorkspace } = await import('./workspace');
    const agent = agentsById.get(run.agentId);
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

/**
 * Workspace-relative file paths an agent *mentions* in its answer — markdown
 * link targets, backticked paths, or bare `a/b/c.ext` tokens. Lets a card
 * surface the write-up its answer points to even when the file was produced by
 * a shell command (or any tool) rather than a captured fs_write step. Paths are
 * confined to the run's workspace: absolute paths and anything that escapes via
 * `..` are dropped, since the answer text is agent-controlled and the card id
 * later acts as the capability to read these files.
 */
function filePathsFromText(text: string, workDir: string): Array<{ relPath: string; absPath: string }> {
  if (!text) return [];
  const cands = new Set<string>();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) cands.add(m[1]);       // [label](target)
  for (const m of text.matchAll(/`([^`]+?)`/g)) cands.add(m[1]);                     // `backticked`
  for (const m of text.matchAll(/(?:^|[\s(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})/g)) cands.add(m[1]); // a/b/c.ext

  const out: Array<{ relPath: string; absPath: string }> = [];
  const seen = new Set<string>();
  for (const raw of cands) {
    const cand = raw.trim().replace(/[)\].,;:>]+$/, '');
    if (!cand || /^[a-z][a-z0-9+.-]*:\/\//i.test(cand) || cand.startsWith('//') || cand.startsWith('#')) continue;
    if (path.isAbsolute(cand)) continue;                       // workspace-relative refs only
    const abs = path.normalize(path.join(workDir, cand));
    const rel = path.relative(workDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // never escape the workspace
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ relPath: cand, absPath: abs });
  }
  return out;
}

export async function collectCardWork(idOrKey: string): Promise<CardWork | null> {
  const task = await getBoardTask(idOrKey);
  if (!task) return null;

  const runs: WorkRun[] = [];
  const fileMap = new Map<string, WorkFile>();
  const sourceRuns = (await Promise.all(task.runIds.map((runId) => getRun(runId).catch(() => null))))
    .filter((run): run is AgentRun => run !== null);
  const agentsById = await loadAgentWorkspaceMap(sourceRuns);

  for (const run of sourceRuns) {
    const runId = run.id;
    runs.push({
      runId: run.id,
      agentName: run.agentName,
      status: run.status,
      completedAt: run.completedAt || null,
      finalOutput: run.finalOutput || '',
    });
    const workDir = await runWorkDir(run, agentsById);
    for (const f of filePathsFromTrace(run, workDir)) {
      const stat = await fs.stat(f.absPath).catch(() => null);
      const kind = fileKind(f.absPath);
      const exists = !!stat?.isFile();
      // Later runs win the dedupe — their version of the file is current.
      fileMap.set(f.absPath.toLowerCase(), {
        name: path.basename(f.absPath),
        relPath: f.relPath,
        absPath: f.absPath,
        exists,
        size: stat?.isFile() ? stat.size : 0,
        mtime: stat?.isFile() ? stat.mtime.toISOString() : null,
        kind,
        preview: exists && kind === 'text' ? await textPreview(f.absPath) : undefined,
        runId,
      });
    }
    // Files the answer points to that weren't captured as fs_write steps —
    // only real, in-workspace files, and never overriding a trace deliverable.
    for (const f of filePathsFromText(run.finalOutput || '', workDir)) {
      const key = f.absPath.toLowerCase();
      if (fileMap.has(key)) continue;
      const stat = await fs.stat(f.absPath).catch(() => null);
      if (!stat?.isFile()) continue;
      const kind = fileKind(f.absPath);
      fileMap.set(key, {
        name: path.basename(f.absPath),
        relPath: f.relPath,
        absPath: f.absPath,
        exists: true,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind,
        preview: kind === 'text' ? await textPreview(f.absPath) : undefined,
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

/** A created file, plus which run/agent produced it — for the global Files view. */
export interface CreatedFile extends WorkFile {
  agentName: string;
  createdAt: string | null;
  /** Workspace root captured for the producing run, used only to group the Files explorer. */
  workspaceRoot: string;
}

/**
 * Every file the agents have created that still exists on disk — the union of
 * fs_write / generate_image trace outputs and files an answer points to, across
 * all recent runs. Deduped by path (newest run wins), newest first. This is the
 * data behind the Files page.
 */
export async function collectAllCreatedFiles(): Promise<CreatedFile[]> {
  const runs = await loadRuns();
  // Newest first lets the winning run claim a path before any older duplicate
  // causes another stat or preview read.
  const ordered = [...runs].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const agentsById = await loadAgentWorkspaceMap(ordered);
  const map = new Map<string, CreatedFile>();
  for (const run of ordered) {
    const workDir = await runWorkDir(run, agentsById);
    const candidates = [
      ...filePathsFromTrace(run, workDir),
      ...filePathsFromText(run.finalOutput || '', workDir),
    ];
    const seenInRun = new Set<string>();
    for (const f of candidates) {
      const key = f.absPath.toLowerCase();
      if (seenInRun.has(key) || map.has(key)) continue;
      seenInRun.add(key);
      const stat = await fs.stat(f.absPath).catch(() => null);
      if (!stat?.isFile()) continue; // the Files view tracks real, on-disk deliverables
      const kind = fileKind(f.absPath);
      map.set(key, {
        name: path.basename(f.absPath),
        relPath: f.relPath,
        absPath: f.absPath,
        exists: true,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind,
        preview: kind === 'text' ? await textPreview(f.absPath) : undefined,
        runId: run.id,
        agentName: run.agentName,
        createdAt: run.completedAt || run.startedAt || null,
        workspaceRoot: workDir,
      });
    }
  }
  return [...map.values()].sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
}

/** Capability check for serving a Files-page file: only paths that really are
 *  tracked created files may be read through the endpoint. */
export async function resolveCreatedFile(absPath: string): Promise<CreatedFile | null> {
  const wanted = path.normalize(absPath).toLowerCase();
  const runs = await loadRuns();
  const ordered = [...runs].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const agentsById = await loadAgentWorkspaceMap(ordered);

  for (const run of ordered) {
    const workDir = await runWorkDir(run, agentsById);
    const candidates = [
      ...filePathsFromTrace(run, workDir),
      ...filePathsFromText(run.finalOutput || '', workDir),
    ];
    const seen = new Set<string>();
    for (const file of candidates) {
      const key = file.absPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (key !== wanted) continue;
      const stat = await fs.stat(file.absPath).catch(() => null);
      if (!stat?.isFile()) continue;
      return {
        name: path.basename(file.absPath),
        relPath: file.relPath,
        absPath: file.absPath,
        exists: true,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        kind: fileKind(file.absPath),
        runId: run.id,
        agentName: run.agentName,
        createdAt: run.completedAt || run.startedAt || null,
        workspaceRoot: workDir,
      };
    }
  }
  return null;
}
