import path from 'node:path';
import type { TaskRecord, TaskWorkspaceRoot } from './task-types';
import { getTask } from './task-ledger';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

export interface ResolvedTaskPath {
  task: TaskRecord;
  root: TaskWorkspaceRoot;
  rootReal: string;
  absolute: string;
  relativePath: string;
}

export interface TaskToolDecision {
  allowed: boolean;
  reason?: string;
  requiresLiveApproval?: boolean;
}

const INTEGRATION_TOOL_SCOPES: Record<string, string> = {
  github_create_issue: 'github',
  github_list_repos: 'github',
  github_create_pr: 'github',
  slack_post: 'slack',
  discord_post: 'discord',
  x_post: 'x',
  x_read_timeline: 'x',
  reddit_read_posts: 'reddit',
  reddit_submit: 'reddit',
  drive_list: 'googledrive',
  drive_upload: 'googledrive',
  obsidian_list: 'obsidian',
  obsidian_read: 'obsidian',
  obsidian_write: 'obsidian',
  obsidian_search: 'obsidian',
  vercel_list_projects: 'vercel',
  vercel_list_deployments: 'vercel',
  vercel_get_deployment: 'vercel',
  vercel_deploy: 'vercel',
  vercel_set_env: 'vercel',
  netlify_list_sites: 'netlify',
  netlify_list_deploys: 'netlify',
  netlify_get_deploy: 'netlify',
  netlify_deploy: 'netlify',
  netlify_set_env: 'netlify',
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_screenshot: 'browser',
  browser_extract: 'browser',
  native_node_action: 'native',
  web_fetch: 'web',
  web_search: 'web',
};

function pathKey(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonicalRoot(root: TaskWorkspaceRoot): Promise<string> {
  const absolute = path.resolve(root.path);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Task workspace root does not exist: ${root.path}`);
  return fs.realpath(absolute);
}

async function canonicalTarget(target: string, write: boolean): Promise<string> {
  let existing = path.resolve(target);
  while (true) {
    try {
      const stat = await fs.lstat(existing);
      if (existing === path.resolve(target) && stat.isSymbolicLink()) {
        throw new Error('Task file paths cannot target a symbolic link');
      }
      if (write && existing === path.resolve(target) && stat.isFile() && stat.nlink > 1) {
        throw new Error('Task writes cannot target a multiply-linked file');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!write) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Cannot resolve task path: ${target}`);
      existing = parent;
    }
  }
  const existingReal = await fs.realpath(existing);
  if (existing === path.resolve(target)) return existingReal;
  const suffix = path.relative(existing, path.resolve(target));
  return path.resolve(existingReal, suffix);
}

/**
 * Resolve a model-provided path against the exact durable task roots. Both the
 * root and the nearest existing target ancestor are realpathed, which closes
 * lexical `..` and symlink escapes. Reads accept read/write roots; writes only
 * accept explicitly writable roots.
 */
export async function resolveTaskPath(input: {
  taskId: string;
  requestedPath: string;
  workDir: string;
  access: 'read' | 'write';
  requireDirectory?: boolean;
}): Promise<ResolvedTaskPath> {
  const task = getTask(input.taskId);
  if (!task) throw new Error('The run task no longer exists');
  const requested = String(input.requestedPath || (input.requireDirectory ? '.' : '')).trim();
  if (!requested || requested.includes('\0')) throw new Error('A valid task workspace path is required');
  const lexical = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(input.workDir, requested);
  const canonical = await canonicalTarget(lexical, input.access === 'write');
  const matches: Array<{ root: TaskWorkspaceRoot; rootReal: string }> = [];
  for (const root of task.workspaceRoots) {
    if (input.access === 'write' && root.permission !== 'write') continue;
    const rootReal = await canonicalRoot(root);
    if (isInside(rootReal, canonical)) matches.push({ root, rootReal });
  }
  matches.sort((a, b) => b.rootReal.length - a.rootReal.length);
  const match = matches[0];
  if (!match) {
    const permission = input.access === 'write' ? 'writable' : 'readable';
    throw new Error(`${input.access === 'write' ? 'Write' : 'Read'} denied: ${requested} is outside this task's ${permission} workspace roots`);
  }
  if (input.requireDirectory) {
    const stat = await fs.stat(canonical).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Task workspace path is not a directory: ${requested}`);
  }
  const relativePath = path.relative(match.rootReal, canonical).replace(/\\/g, '/');
  return { task, root: match.root, rootReal: match.rootReal, absolute: canonical, relativePath };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function isTeamWorker(task: TaskRecord): boolean {
  return typeof task.metadata.teamWorkerKey === 'string';
}

/** Defense-in-depth policy used both when offering tools and at dispatch. */
export function taskToolDecision(taskId: string | undefined, toolName: string, args: Record<string, unknown> = {}): TaskToolDecision {
  if (!taskId) return { allowed: true };
  const task = getTask(taskId);
  if (!task) return { allowed: false, reason: 'The run task no longer exists' };
  const readOnly = task.metadata.readOnly === true || !task.workspaceRoots.some((root) => root.permission === 'write');

  if (toolName === 'terminal_exec') {
    return { allowed: false, reason: 'The shared Studio Terminal is not task-workspace-contained; use an explicitly approved shell_exec instead.' };
  }
  if (toolName === 'shell_exec') {
    if (readOnly) return { allowed: false, reason: 'Read-only tasks cannot execute host shell commands.' };
    return { allowed: true, requiresLiveApproval: true };
  }
  if (readOnly && ['fs_write', 'grok_cli', 'sandbox_write_file', 'generate_image', 'github_create_pr', 'reddit_submit'].includes(toolName)) {
    return { allowed: false, reason: `Read-only tasks cannot use ${toolName}.` };
  }

  if (!isTeamWorker(task)) return { allowed: true };
  const allowedTools = stringList(task.metadata.allowedTools);
  if (allowedTools && !allowedTools.includes(toolName.toLowerCase())) {
    return { allowed: false, reason: `Tool ${toolName} is outside this worker's allowedTools grant.` };
  }

  const integrationScopes = stringList(task.metadata.integrationScopes) ?? [];
  const fixedScope = INTEGRATION_TOOL_SCOPES[toolName];
  if (fixedScope && !integrationScopes.includes(fixedScope)) {
    return { allowed: false, reason: `Tool ${toolName} requires the worker integration scope "${fixedScope}".` };
  }
  if (toolName === 'mcp_list_tools' || toolName === 'mcp_invoke') {
    const server = String(args.server || '').trim().toLowerCase();
    const anyScopedMcp = integrationScopes.some((scope) => scope.startsWith('mcp:'));
    if (!integrationScopes.includes('mcp') && (server ? !integrationScopes.includes(`mcp:${server}`) : !anyScopedMcp)) {
      return { allowed: false, reason: `MCP access is outside this worker's integrationScopes grant.` };
    }
  }
  return { allowed: true };
}

/**
 * A shell remains a powerful expansion even with a contained cwd. Reject the
 * common path/nested-shell escape classes; an exact live approval is still
 * mandatory because Node cannot provide an OS filesystem sandbox here.
 */
export function assertTaskShellCommand(commandValue: unknown): string {
  const command = String(commandValue || '').trim();
  if (!command || command.length > 8_000 || command.includes('\0')) throw new Error('A bounded shell command is required');
  if (/[\r\n;&|<>`^]/.test(command) || /\$\(|\$\{|\$env:|\$[A-Za-z_]|%[^%\s]+%|![A-Za-z_][A-Za-z0-9_]*!/i.test(command)) {
    throw new Error('Task shell commands cannot use chaining, redirection, substitution, or environment-path expansion');
  }
  if (/(^|[\s"'/\\])\.\.([/\\]|$)/.test(command) || /(^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/[^\s/])/i.test(command) || /(^|[\s"'])~[\\/]/.test(command)) {
    throw new Error('Task shell commands cannot reference absolute, home, or parent paths');
  }
  if (/\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash|sh|zsh|fish|wsl|python(?:3|\.exe)?|perl|ruby)\b/i.test(command)
    || /\bnode(?:\.exe)?\s+(?:-e|--eval|-p|--print)\b/i.test(command)) {
    throw new Error('Task shell commands cannot launch nested shells or inline interpreters');
  }
  if (/\bgit\s+(?:add|am|apply|branch(?!\s+--show-current\b)|checkout|cherry-pick|clean|clone|commit|fetch|init|merge|mv|pull|push|rebase|reset|restore|rm|submodule|switch|tag|worktree)\b/i.test(command)
    || /(^|[\\/\s"'])\.git(?:[\\/\s"']|$)/i.test(command)) {
    throw new Error('Task shell commands cannot mutate Git metadata; use a dedicated approval-gated Git action');
  }
  return command;
}
