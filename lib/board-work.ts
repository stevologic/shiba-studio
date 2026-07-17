// Collects the delivered work behind a board card: completion state, bounded
// action evidence, final answers, and every file its linked runs changed.
// Files are resolved and stat-checked so the UI can link straight to them.

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
  /** Bounded, display-safe proof of what the run actually did. */
  evidence: WorkEvidence[];
  /** Whether the run delivered work, stopped partway through, or only promised future work. */
  deliveryState: 'delivered' | 'partial' | 'not_delivered';
  /** Plain-language context for partial / missing delivery states. */
  deliveryMessage?: string;
}

export interface WorkEvidence {
  kind: 'change' | 'external' | 'verification' | 'research';
  label: string;
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
const MAX_WORK_EVIDENCE = 8;
const MAX_EVIDENCE_LABEL = 160;

type EvidenceBucket = Record<WorkEvidence['kind'], WorkEvidence[]>;

function cleanEvidenceLabel(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_EVIDENCE_LABEL) return oneLine;
  return `${oneLine.slice(0, MAX_EVIDENCE_LABEL - 1).trimEnd()}…`;
}

/**
 * Only surface paths that are clearly workspace-relative. Trace and side-effect
 * text is agent-controlled, so absolute paths, URLs, and parent traversal never
 * become evidence labels.
 */
function safeEvidencePath(value: unknown): string | null {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (
    !raw
    || raw.length > 500
    || path.isAbsolute(raw)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || raw.startsWith('//')
    || /[\u0000-\u001f\u007f<>:"|?*=]/.test(raw)
    || /\b(?:api[_-]?key|token|secret|password|authorization|bearer)\b/i.test(raw)
  ) return null;
  const normalized = path.normalize(raw);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return null;
  return cleanEvidenceLabel(raw);
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function traceStepFailed(step: TraceStep): boolean {
  if (step.tool?.error) return true;
  const rawResult = step.tool?.result;
  const result = resultRecord(rawResult);
  if (
    result?.denied === true
    || result?.ok === false
    || result?.success === false
    || Boolean(result?.error)
    || /^(?:denied|blocked|failed|error)$/i.test(String(result?.status || ''))
  ) return true;
  const failureText = `${step.content || ''}\n${typeof rawResult === 'string' ? rawResult : ''}`;
  return /\b(?:denied|blocked|failed|unavailable|error)\b/i.test(failureText);
}

function evidenceFromRun(run: AgentRun): WorkEvidence[] {
  const buckets: EvidenceBucket = {
    change: [],
    external: [],
    verification: [],
    research: [],
  };
  const seen = new Set<string>();

  const add = (kind: WorkEvidence['kind'], rawLabel: string) => {
    if (buckets[kind].length >= MAX_WORK_EVIDENCE) return;
    const label = cleanEvidenceLabel(rawLabel);
    if (!label) return;
    const key = `${kind}:${label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    buckets[kind].push({ kind, label });
  };

  // Tool results are intentionally reduced to allowlisted action summaries.
  // Raw args, raw output, prompts, commands, URLs, and integration payloads
  // never cross into the View Work response.
  for (const step of (run.trace || []).slice(-500)) {
    const tool = step.tool;
    // A `tool` step is only an attempt; the matching `result` proves it ran.
    if (step.type !== 'result' || !tool || traceStepFailed(step)) continue;
    const args = resultRecord(tool.args);
    const result = resultRecord(tool.result);
    const toolPath = safeEvidencePath(result?.path ?? args?.path);

    switch (tool.name) {
      case 'workspace_change': {
        if (!toolPath) break;
        const rawKind = String(result?.kind ?? args?.kind ?? '').toLowerCase();
        const verb = /^(?:add|added|create|created|new)$/.test(rawKind)
          ? 'Created'
          : /^(?:delete|deleted|remove|removed)$/.test(rawKind)
            ? 'Deleted'
            : 'Changed';
        add('change', `${verb} ${toolPath}`);
        break;
      }
      case 'fs_write':
      case 'sandbox_write_file':
        add('change', toolPath ? `Wrote ${toolPath}` : 'Wrote a workspace file');
        break;
      case 'generate_image':
        add('change', toolPath ? `Generated ${toolPath}` : 'Generated an image');
        break;
      case 'obsidian_write':
        add('change', 'Updated an Obsidian note');
        break;
      case 'drive_upload':
        add('external', 'Uploaded a file to Google Drive');
        break;
      case 'github_create_issue':
        add('external', 'Created a GitHub issue');
        break;
      case 'github_create_pr':
        add('external', 'Opened a GitHub pull request');
        break;
      case 'slack_post':
        add('external', 'Posted a Slack message');
        break;
      case 'discord_post':
        add('external', 'Posted a Discord message');
        break;
      case 'x_post':
        add('external', 'Published a post on X');
        break;
      case 'reddit_submit':
        add('external', 'Published a Reddit post');
        break;
      case 'vercel_deploy':
        add('external', 'Started a Vercel deployment');
        break;
      case 'netlify_deploy':
        add('external', 'Started a Netlify deployment');
        break;
      case 'vercel_set_env':
        add('external', 'Updated a Vercel environment setting');
        break;
      case 'netlify_set_env':
        add('external', 'Updated a Netlify environment setting');
        break;
      case 'shell_exec':
      case 'terminal_exec':
      case 'sandbox_exec':
        add('verification', 'Ran a workspace command');
        break;
      case 'native_node_action':
        add('verification', 'Ran a native workspace action');
        break;
      case 'browser_screenshot':
        add('verification', 'Captured a browser screenshot');
        break;
      case 'vercel_get_deployment':
        add('verification', 'Checked a Vercel deployment');
        break;
      case 'netlify_get_deploy':
        add('verification', 'Checked a Netlify deployment');
        break;
      case 'fs_list':
      case 'fs_read':
      case 'fs_search':
        add('research', 'Inspected workspace files');
        break;
      case 'web_fetch':
      case 'web_search':
        add('research', 'Researched source material');
        break;
      case 'browser_navigate':
      case 'browser_click':
      case 'browser_type':
      case 'browser_extract':
        add('research', 'Inspected a web page');
        break;
      case 'github_list_repos':
        add('research', 'Reviewed GitHub repositories');
        break;
      case 'drive_list':
        add('research', 'Reviewed Google Drive files');
        break;
      case 'obsidian_list':
      case 'obsidian_read':
      case 'obsidian_search':
        add('research', 'Reviewed Obsidian notes');
        break;
      case 'x_read_timeline':
      case 'reddit_read_posts':
        add('research', 'Reviewed social sources');
        break;
      case 'vercel_list_projects':
      case 'vercel_list_deployments':
        add('research', 'Reviewed Vercel project activity');
        break;
      case 'netlify_list_sites':
      case 'netlify_list_deploys':
        add('research', 'Reviewed Netlify site activity');
        break;
    }
  }

  // Older traces did not always retain tool metadata. Recognize only a small
  // set of known side-effect prefixes, reducing them to generic safe labels.
  for (const sideEffect of (run.sideEffects || []).slice(-200)) {
    const effect = String(sideEffect || '').slice(0, 1_000).trim();
    const lower = effect.toLowerCase();
    if (!effect || /\b(?:blocked|failed|unavailable)\b/i.test(effect)) continue;
    if (lower.startsWith('wrote file ')) {
      const filePath = safeEvidencePath(effect.slice('wrote file '.length));
      add('change', filePath ? `Wrote ${filePath}` : 'Wrote a workspace file');
    } else if (lower.startsWith('generated image')) {
      if (!buckets.change.some((item) => item.label.startsWith('Generated '))) {
        add('change', 'Generated an image');
      }
    } else if (lower.startsWith('uploaded ') && lower.includes(' to drive')) {
      add('external', 'Uploaded a file to Google Drive');
    } else if (lower.startsWith('created gh issue')) {
      add('external', 'Created a GitHub issue');
    } else if (lower.startsWith('opened github pr')) {
      add('external', 'Opened a GitHub pull request');
    } else if (lower.startsWith('posted to slack')) {
      add('external', 'Posted a Slack message');
    } else if (lower.startsWith('posted to discord')) {
      add('external', 'Posted a Discord message');
    } else if (lower.startsWith('posted to x')) {
      add('external', 'Published a post on X');
    } else if (lower.startsWith('posted to reddit')) {
      add('external', 'Published a Reddit post');
    } else if (lower.startsWith('vercel deploy started')) {
      add('external', 'Started a Vercel deployment');
    } else if (lower.startsWith('netlify deploy started')) {
      add('external', 'Started a Netlify deployment');
    } else if (/^(?:shell|terminal|sandbox):/i.test(effect)) {
      if (buckets.verification.length === 0) add('verification', 'Ran a workspace command');
    } else if (lower === 'captured screenshot') {
      add('verification', 'Captured a browser screenshot');
    } else if (
      lower.startsWith('read ')
      || lower.startsWith('listed ')
      || lower.startsWith('searched ')
      || lower.startsWith('fetched ')
      || lower.startsWith('web search ')
      || lower.startsWith('navigated to ')
      || lower === 'extracted text'
    ) {
      if (buckets.research.length === 0) add('research', 'Inspected source material');
    }
  }

  // Concrete delivery evidence is most useful, so it wins the bounded list
  // even when a run contains a long sequence of research actions first.
  return [
    ...buckets.change,
    ...buckets.external,
    ...buckets.verification,
    ...buckets.research,
  ].slice(0, MAX_WORK_EVIDENCE);
}

function looksLikePromiseOnlyOutput(output: string): boolean {
  const value = output.trim();
  if (!value || value.length > 700) return false;
  const sentences = value.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim());
  if (sentences.length > 3) return false;
  return /^(?:(?:sure|okay|ok)[,.]?\s+)?(?:(?:first|next)[,.]?\s+)?(?:i(?:'ll| will)|i(?:'m| am) going to|let me)\s+(?:start|begin|pull|fetch|read|inspect|review|locate|check|look|analy[sz]e|investigate|work|implement|fix|create|update|open)\b/i.test(value);
}

export function classifyWorkRunDelivery(
  run: AgentRun,
  evidence: WorkEvidence[],
): Pick<WorkRun, 'deliveryState' | 'deliveryMessage'> {
  const answer = (run.finalOutput || '').trim();
  const promiseOnly = looksLikePromiseOnlyOutput(answer);
  const hasConcreteEvidence = evidence.some((item) => item.kind === 'change' || item.kind === 'external');

  if (run.status === 'running' || run.status === 'scheduled') {
    return {
      deliveryState: 'partial',
      deliveryMessage: 'This run is still in progress, so the work shown here may be incomplete.',
    };
  }
  if (promiseOnly && !hasConcreteEvidence) {
    return {
      deliveryState: 'not_delivered',
      deliveryMessage: 'This run only described what it planned to do. No completed work was recorded.',
    };
  }
  if (run.status === 'error') {
    return evidence.length > 0
      ? {
          deliveryState: 'partial',
          deliveryMessage: 'This run stopped with an error. Only the work recorded before it stopped is shown.',
        }
      : {
          deliveryState: 'not_delivered',
          deliveryMessage: 'This run stopped with an error before any completed work was recorded.',
        };
  }
  if (!answer && !hasConcreteEvidence) {
    return {
      deliveryState: 'not_delivered',
      deliveryMessage: 'No completed work or final answer was recorded for this run.',
    };
  }
  if (promiseOnly) {
    return {
      deliveryState: 'partial',
      deliveryMessage: 'This run recorded changes, but its final response only described planned next steps.',
    };
  }
  return { deliveryState: 'delivered' };
}

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

interface WorkspaceBoundary {
  lexicalRoot: string;
  realRoot: string;
}

interface WorkspaceFilePath {
  relPath: string;
  absPath: string;
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function loadWorkspaceBoundary(workDir: string): Promise<WorkspaceBoundary | null> {
  const lexicalRoot = path.resolve(workDir);
  const realRoot = await fs.realpath(lexicalRoot).catch(() => null);
  return realRoot ? { lexicalRoot, realRoot: path.normalize(realRoot) } : null;
}

/**
 * Normalize an agent-controlled path and prove it stays inside the run's real
 * workspace. Existing symlinks are resolved before the path can be statted,
 * previewed, returned by an API, or used as a file-serving capability.
 */
async function confineWorkspaceFile(
  boundary: WorkspaceBoundary,
  value: unknown,
): Promise<WorkspaceFilePath | null> {
  const raw = String(value || '').trim();
  if (
    !raw
    || raw.includes('\0')
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || raw.startsWith('//')
  ) return null;

  const lexicalCandidate = path.resolve(boundary.lexicalRoot, raw);
  if (lexicalCandidate === boundary.lexicalRoot || !isInsidePath(boundary.lexicalRoot, lexicalCandidate)) {
    return null;
  }
  const relPath = path.relative(boundary.lexicalRoot, lexicalCandidate);
  const realCandidate = await fs.realpath(lexicalCandidate).catch(() => null);
  if (realCandidate) {
    const normalizedReal = path.normalize(realCandidate);
    if (!isInsidePath(boundary.realRoot, normalizedReal)) return null;
    return { relPath, absPath: normalizedReal };
  }

  // Missing outputs can still be shown as missing, but first resolve the
  // nearest existing ancestor so an in-workspace symlink cannot smuggle the
  // candidate into a directory outside the workspace.
  let ancestor = path.dirname(lexicalCandidate);
  while (isInsidePath(boundary.lexicalRoot, ancestor)) {
    const realAncestor = await fs.realpath(ancestor).catch(() => null);
    if (realAncestor) {
      if (!isInsidePath(boundary.realRoot, path.normalize(realAncestor))) return null;
      return { relPath, absPath: lexicalCandidate };
    }
    if (ancestor === boundary.lexicalRoot) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return null;
}

/** Pull created/changed-file paths out of one run's trace. */
async function filePathsFromTrace(run: AgentRun, workDir: string): Promise<WorkspaceFilePath[]> {
  const boundary = await loadWorkspaceBoundary(workDir);
  if (!boundary) return [];
  const trace = run.trace || [];
  // Very old successful runs stored only `tool` steps. Modern runs always
  // include result steps, so only the all-tool legacy format may use a tool
  // step itself as proof of a completed write.
  const legacyToolOnlyTrace = run.status === 'completed' && !trace.some((step) => step.type === 'result');
  const candidates: unknown[] = [];

  for (const step of trace) {
    const traceStep = step as TraceStep;
    const tool = traceStep.tool;
    if (!tool || !['tool', 'result'].includes(traceStep.type)) continue;
    const completedResult = traceStep.type === 'result' && !traceStepFailed(traceStep);
    if (tool.name === 'fs_write') {
      if (!completedResult && !(legacyToolOnlyTrace && !traceStepFailed(traceStep))) continue;
      candidates.push((tool.args as { path?: unknown } | undefined)?.path);
    } else if (tool.name === 'generate_image') {
      if (!completedResult && !(legacyToolOnlyTrace && !traceStepFailed(traceStep))) continue;
      candidates.push((tool.result as { path?: unknown } | undefined)?.path);
    } else if (tool.name === 'workspace_change') {
      if (!completedResult) continue;
      const args = resultRecord(tool.args);
      const result = resultRecord(tool.result);
      const changeKind = String(result?.kind ?? args?.kind ?? '').toLowerCase();
      if (/^(?:delete|deleted|remove|removed)$/.test(changeKind)) continue;
      candidates.push(result?.path ?? args?.path);
    }
  }

  const out: WorkspaceFilePath[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const confined = await confineWorkspaceFile(boundary, candidate);
    if (!confined) continue;
    const key = confined.absPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(confined);
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
async function filePathsFromText(text: string, workDir: string): Promise<WorkspaceFilePath[]> {
  if (!text) return [];
  const boundary = await loadWorkspaceBoundary(workDir);
  if (!boundary) return [];
  const cands = new Set<string>();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) cands.add(m[1]);       // [label](target)
  for (const m of text.matchAll(/`([^`]+?)`/g)) cands.add(m[1]);                     // `backticked`
  for (const m of text.matchAll(/(?:^|[\s(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})/g)) cands.add(m[1]); // a/b/c.ext

  const out: WorkspaceFilePath[] = [];
  const seen = new Set<string>();
  for (const raw of cands) {
    const cand = raw.trim().replace(/[)\].,;:>]+$/, '');
    if (!cand || /^[a-z][a-z0-9+.-]*:\/\//i.test(cand) || cand.startsWith('//') || cand.startsWith('#')) continue;
    if (path.isAbsolute(cand)) continue;                       // workspace-relative refs only
    const confined = await confineWorkspaceFile(boundary, cand);
    if (!confined) continue;
    const key = confined.absPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(confined);
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
    const evidence = evidenceFromRun(run);
    runs.push({
      runId: run.id,
      agentName: run.agentName,
      status: run.status,
      completedAt: run.completedAt || null,
      finalOutput: run.finalOutput || '',
      evidence,
      ...classifyWorkRunDelivery(run, evidence),
    });
    const workDir = await runWorkDir(run, agentsById);
    const [traceFiles, answerFiles] = await Promise.all([
      filePathsFromTrace(run, workDir),
      filePathsFromText(run.finalOutput || '', workDir),
    ]);
    for (const f of traceFiles) {
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
    for (const f of answerFiles) {
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
  return work.files.find((f) => f.exists && f.absPath.toLowerCase() === wanted) || null;
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
    const [traceFiles, answerFiles] = await Promise.all([
      filePathsFromTrace(run, workDir),
      filePathsFromText(run.finalOutput || '', workDir),
    ]);
    const candidates = [
      ...traceFiles,
      ...answerFiles,
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
    const [traceFiles, answerFiles] = await Promise.all([
      filePathsFromTrace(run, workDir),
      filePathsFromText(run.finalOutput || '', workDir),
    ]);
    const candidates = [
      ...traceFiles,
      ...answerFiles,
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
