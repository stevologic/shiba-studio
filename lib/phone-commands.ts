/**
 * Server-side spoken-command executor used by the phone MCP, JSON webhook,
 * and SIP function-call path. Chat slash commands stay client-side; this is
 * the shared host implementation those remote surfaces actually run.
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { audit } from './audit-log';
import { dispatchExistingTask } from './background-tasks';
import { parseSlashCommand, renderChatCommandHelp } from './chat-commands';
import {
  appendChatMessage,
  createChatSession,
  getChatSession,
  updateChatSession,
} from './chat-sessions';
import { PHONE_CHAT_SESSION_ID, PHONE_CHAT_TITLE } from './phone-assistant';
import { recommendTaskMode } from './task-router';
import { createTask } from './task-ledger';
import { resolveWorkspace } from './workspace';

export interface PhoneCommandResult {
  ok: boolean;
  action: string;
  spoken: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface PhoneToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const MAX_UTTERANCE = 8_000;
const MAX_SPOKEN = 700;

const UI_ONLY = new Set(['clear', 'agent', 'model', 'tools', 'project', 'workspace', 'annotate', 'memories']);

export const PHONE_TOOLS: PhoneToolDefinition[] = [
  {
    name: 'dictate_command',
    description: 'Execute a spoken Shiba Studio command. Accepts slash commands or natural language (create a task, list the board, git status, remember, search, start work).',
    inputSchema: {
      type: 'object',
      properties: { utterance: { type: 'string', description: 'Exactly what the caller asked Shiba to do.' } },
      required: ['utterance'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a Board card in the backlog.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_board',
    description: 'List Board cards, optionally filtered by status or text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Status (backlog, todo, in_progress) or free text.' } },
    },
  },
  {
    name: 'start_work',
    description: 'Create and dispatch a durable Studio task from a spoken brief so Grok works it in the background.',
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string', description: 'Complete outcome the agent should produce.' } },
      required: ['brief'],
    },
  },
  {
    name: 'git',
    description: 'Run a git action against the default workspace: status, diff, log, checkout, commit, pull, push, or pr.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log', 'checkout', 'commit', 'pull', 'push', 'pr'] },
        branch: { type: 'string' },
        message: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        staged: { type: 'boolean' },
        count: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'remember',
    description: 'Save a durable memory for shared chat.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, content: { type: 'string' } },
      required: ['key', 'content'],
    },
  },
  {
    name: 'recall',
    description: 'Recall matching active memories.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
  },
  {
    name: 'forget',
    description: 'Delete one memory by exact key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'search_web',
    description: 'Search the web and return titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Read a web page as clean text.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'studio_status',
    description: 'Summarize recent board cards and open durable tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function spoken(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SPOKEN);
}

function fail(action: string, message: string, data?: Record<string, unknown>): PhoneCommandResult {
  return { ok: false, action, spoken: spoken(message), detail: message, ...(data ? { data } : {}) };
}

function ok(action: string, message: string, data?: Record<string, unknown>): PhoneCommandResult {
  return { ok: true, action, spoken: spoken(message), detail: message, ...(data ? { data } : {}) };
}

export function normalizeSpokenUtterance(raw: string): string {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/^(hey |ok |okay )?(shiba|studio|grok)[,:]?\s+/i, '');
  text = text.replace(/^(please |can you |could you |would you |go ahead and )/i, '');
  if (/^slash\s+/i.test(text) || /^forward slash\s+/i.test(text)) {
    text = `/${text.replace(/^(slash|forward slash)\s+/i, '')}`;
  }
  return text.slice(0, MAX_UTTERANCE);
}

function firstGroup(match: RegExpExecArray | null, index = 1): string {
  return match?.[index]?.trim() || '';
}

/** Map natural speech onto the same slash-command names the chat catalog uses. */
export function resolveSpokenCommand(utterance: string): { name: string; args: string } | { kind: 'work'; brief: string } | { kind: 'status' } {
  const text = normalizeSpokenUtterance(utterance);
  if (!text) return { name: 'help', args: '' };

  const parsed = parseSlashCommand(text.startsWith('/') ? text : '');
  if (parsed) return parsed;

  const lower = text.toLowerCase();

  if (/^(help|what can you do|commands?|what do you support)\b/.test(lower)) return { name: 'help', args: '' };
  if (/^(status|what'?s (going on|running|on the studio)|studio status)\b/.test(lower)) return { kind: 'status' };

  const boardList = /^(list|show|read|what'?s|whats)\s+(on\s+)?(the\s+)?board\b(.*)$/i.exec(text);
  if (boardList) return { name: 'board', args: firstGroup(boardList, 4) };

  const task = /^(create|add|make|open|file)\s+(a\s+)?(new\s+)?(task|card|ticket)\b(?:\s+(?:to|for|titled|called|about|:)\s+)?(.*)$/i.exec(text);
  if (task) return { name: 'task', args: firstGroup(task, 5).replace(/^[:\-]\s*/, '') };

  const remember = /^(remember|save memory|note to self)\b(?:\s+that)?\s*(.*)$/i.exec(text);
  if (remember) {
    const rest = firstGroup(remember, 2);
    const split = rest.split(/\s+is\s+|\s+\|\s+/i);
    if (split.length >= 2) return { name: 'remember', args: `${split[0].trim()} | ${split.slice(1).join(' is ').trim()}` };
    return { name: 'remember', args: rest };
  }

  const recall = /^(recall|what do you remember|memories)\b(.*)$/i.exec(text);
  if (recall) return { name: 'recall', args: firstGroup(recall, 2).replace(/^(about|for)\s+/i, '') };

  const forget = /^(forget|delete memory)\b\s*(.*)$/i.exec(text);
  if (forget) return { name: 'forget', args: firstGroup(forget, 2) };

  const search = /^(search|look up|google|web search)\b\s*(?:for\s+)?(.*)$/i.exec(text);
  if (search) return { name: 'search', args: firstGroup(search, 2) };

  const fetch = /^(fetch|read|open)\s+(https?:\/\/\S+)/i.exec(text);
  if (fetch) return { name: 'fetch', args: firstGroup(fetch, 2) };

  const note = /^(obsidian note|create note|note)\b\s*(.*)$/i.exec(text);
  if (note && /\|/.test(text)) return { name: 'note', args: firstGroup(note, 2) };

  const postX = /^(post|tweet)\s+(to\s+)?x\b\s*(.*)$/i.exec(text);
  if (postX) return { name: 'x', args: firstGroup(postX, 3) };

  const git = /^(git\s+)?(status|diff|log|pull|push|checkout|commit|pr)\b(.*)$/i.exec(text);
  if (git && (/^git\b/i.test(text) || /^(status|diff|log|pull|push)\b/i.test(lower))) {
    const sub = firstGroup(git, 2).toLowerCase();
    const args = firstGroup(git, 3).replace(/^(the changes with message|with message|message)\s+/i, '');
    return { name: 'git', args: `${sub}${args ? ` ${args}` : ''}` };
  }

  if (/^(start work|have grok|run a task|work on|build|implement|fix|investigate)\b/i.test(text)) {
    return { kind: 'work', brief: text.replace(/^(start work( on)?|have grok|run a task)\s+/i, '').trim() || text };
  }

  return { kind: 'work', brief: text };
}

export async function ensurePhoneChatSession(): Promise<{ id: string }> {
  const existing = await getChatSession(PHONE_CHAT_SESSION_ID);
  if (existing) {
    if (existing.title !== PHONE_CHAT_TITLE) {
      await updateChatSession(PHONE_CHAT_SESSION_ID, { title: PHONE_CHAT_TITLE }).catch(() => existing);
    }
    return existing;
  }
  return createChatSession({
    id: PHONE_CHAT_SESSION_ID,
    title: PHONE_CHAT_TITLE,
    chatTarget: 'grok',
  });
}

async function recordPhoneExchange(utterance: string, result: PhoneCommandResult): Promise<void> {
  const session = await ensurePhoneChatSession();
  const createdAt = new Date().toISOString();
  await appendChatMessage(session.id, {
    id: `phone-user-${randomUUID()}`,
    role: 'user',
    content: utterance,
    createdAt,
  });
  await appendChatMessage(session.id, {
    id: `phone-assistant-${randomUUID()}`,
    role: 'assistant',
    content: result.detail,
    agentName: 'Phone assistant',
    createdAt: new Date().toISOString(),
  });
}

async function workspaceCwd(): Promise<string> {
  const { loadConfig } = await import('./persistence');
  const cfg = await loadConfig();
  const requested = cfg.defaultWorkspace?.trim();
  if (!requested) throw new Error('No default workspace is set in Settings.');
  const cwd = resolveWorkspace(requested);
  if (!existsSync(cwd)) throw new Error(`Workspace not found: ${cwd}`);
  return cwd;
}

async function runGit(args: {
  action: string;
  branch?: string;
  message?: string;
  title?: string;
  body?: string;
  staged?: boolean;
  count?: number;
}): Promise<PhoneCommandResult> {
  const cwd = await workspaceCwd();
  const git = await import('./git-actions');
  const action = String(args.action || '').toLowerCase();
  let result: string;
  if (action === 'status') result = await git.gitStatus(cwd);
  else if (action === 'diff') result = await git.gitDiff(cwd, !!args.staged);
  else if (action === 'log') result = await git.gitLog(cwd, Number(args.count) || 10);
  else if (action === 'pull') result = await git.gitPull(cwd);
  else if (action === 'push') result = await git.gitPush(cwd);
  else if (action === 'checkout') result = await git.gitCheckout(cwd, String(args.branch || ''));
  else if (action === 'commit') result = await git.gitCommit(cwd, String(args.message || ''));
  else if (action === 'pr') result = await git.gitCreatePr(cwd, String(args.title || args.message || ''), args.body);
  else return fail('git', `Unknown git action "${action}".`);
  audit('workspace', `phone git ${action}`, cwd);
  return ok('git', result, { cwd, action });
}

async function createBoardCard(title: string, description = ''): Promise<PhoneCommandResult> {
  const trimmed = title.trim();
  if (!trimmed) return fail('task', 'Usage: create a task titled something, or /task title | description.');
  const { createBoardTask } = await import('./board');
  const task = await createBoardTask({ title: trimmed, description: description.trim(), status: 'backlog' });
  audit('config', 'phone board card created', `${task.key}: ${task.title.slice(0, 100)}`);
  return ok('task', `Created ${task.key}: ${task.title} in Backlog.`, {
    key: task.key,
    id: task.id,
    title: task.title,
    status: task.status,
  });
}

async function listBoard(query = ''): Promise<PhoneCommandResult> {
  const { listBoardTasks } = await import('./board');
  const filter = query.trim().toLowerCase().replace(/\s+/g, '_');
  const statuses = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
  const tasks = (await listBoardTasks()).filter((task) => {
    if (!filter) return true;
    if (statuses.has(filter)) return task.status === filter;
    return [task.key, task.title, ...(task.labels || [])].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  }).slice(0, 20);
  if (!tasks.length) return ok('board', query ? `No Board cards matching ${query}.` : 'The board is empty.');
  const lines = tasks.map((task) => `${task.key} ${task.title} (${String(task.status).replace(/_/g, ' ')})`);
  return ok('board', `Board: ${lines.join('; ')}.`, {
    count: tasks.length,
    tasks: tasks.map((task) => ({ key: task.key, title: task.title, status: task.status })),
  });
}

async function startWork(brief: string): Promise<PhoneCommandResult> {
  const outcome = brief.replace(/\s+/g, ' ').trim();
  if (!outcome) return fail('start_work', 'Tell me what to work on.');
  const recommendation = recommendTaskMode({ outcome });
  const kind = recommendation.recommendedMode === 'code' ? 'code' : 'work';
  const session = await ensurePhoneChatSession();
  const task = createTask({
    id: `phone:${randomUUID()}`,
    kind,
    title: outcome.slice(0, 120),
    description: outcome,
    status: 'queued',
    originType: 'api',
    originId: session.id,
    sessionId: session.id,
    maxRetries: 1,
    contract: {
      outcome,
      constraints: ['This request was dictated through the paired Grok phone assistant.'],
      requiredArtifacts: [],
      requirements: [],
    },
    metadata: { phoneAssistant: true, recommendation },
  });
  await dispatchExistingTask(task.id);
  audit('run', 'phone work dispatched', task.title, { taskId: task.id });
  return ok('start_work', `Started work: ${task.title}. Track it as task ${task.id}.`, {
    taskId: task.id,
    taskUrl: `/tasks/${encodeURIComponent(task.id)}`,
    kind,
  });
}

async function studioStatus(): Promise<PhoneCommandResult> {
  const { listBoardTasks } = await import('./board');
  const { listTasks } = await import('./task-ledger');
  const cards = await listBoardTasks();
  const openCards = cards.filter((card) => !['done', 'cancelled'].includes(card.status)).slice(0, 8);
  const openTasks = listTasks({ statuses: ['queued', 'running', 'waiting_for_approval', 'paused'], limit: 8 }).tasks;
  const cardLine = openCards.length
    ? openCards.map((card) => `${card.key} ${card.title}`).join('; ')
    : 'no open board cards';
  const taskLine = openTasks.length
    ? openTasks.map((task) => `${task.status} ${task.title}`).join('; ')
    : 'no open durable tasks';
  return ok('studio_status', `Studio status. Board: ${cardLine}. Work: ${taskLine}.`, {
    boardOpen: openCards.length,
    tasksOpen: openTasks.length,
  });
}

async function executeResolved(resolved: ReturnType<typeof resolveSpokenCommand>): Promise<PhoneCommandResult> {
  if ('kind' in resolved && resolved.kind === 'status') return studioStatus();
  if ('kind' in resolved && resolved.kind === 'work') return startWork(resolved.brief);

  const { name, args } = resolved;
  if (name === 'help') {
    return ok('help', 'I can create board tasks, list the board, run git, remember facts, search the web, or start background work. Say create a task, git status, or start work on…');
  }
  if (UI_ONLY.has(name)) {
    return fail(name, `${name} is a desktop chat command. From the phone I can create tasks, list the board, run git, remember facts, search, or start work.`);
  }
  if (name === 'task') {
    const [title, ...rest] = args.split('|');
    return createBoardCard(title || '', rest.join('|'));
  }
  if (name === 'board') return listBoard(args);
  if (name === 'git') {
    const [sub, ...rest] = args.trim().split(/\s+/);
    const argText = rest.join(' ');
    if (!sub) return fail('git', renderChatCommandHelp());
    if (sub === 'status') return runGit({ action: 'status' });
    if (sub === 'diff') return runGit({ action: 'diff', staged: rest.includes('--staged') || rest.includes('--cached') });
    if (sub === 'log') return runGit({ action: 'log', count: Math.max(1, Math.min(50, Number(rest[0]) || 10)) });
    if (sub === 'pull') return runGit({ action: 'pull' });
    if (sub === 'push') return runGit({ action: 'push' });
    if (sub === 'checkout' && rest[0]) return runGit({ action: 'checkout', branch: rest[0] });
    if (sub === 'commit' && argText) return runGit({ action: 'commit', message: argText });
    if (sub === 'pr' && argText) {
      const [title, ...bodyParts] = argText.split('|');
      return runGit({ action: 'pr', title: title.trim(), body: bodyParts.join('|').trim() });
    }
    return fail('git', 'Supported git actions: status, diff, log, checkout, commit, pull, push, pr.');
  }
  if (name === 'search') {
    if (!args.trim()) return fail('search', 'What should I search for?');
    const { webSearch } = await import('./agent-power-tools');
    const results = await webSearch(args.trim());
    const lines = (results || []).slice(0, 5).map((item: { title?: string; url?: string }, index: number) =>
      `${index + 1}. ${item.title || item.url} ${item.url || ''}`.trim());
    return ok('search', lines.length ? `Search results for ${args}: ${lines.join('; ')}` : `No web results for ${args}.`, { results });
  }
  if (name === 'fetch') {
    if (!args.trim()) return fail('fetch', 'Give me a URL to read.');
    const { webFetch } = await import('./agent-power-tools');
    const page = await webFetch(args.trim());
    const text = String(page?.text || '').slice(0, 1_500);
    return ok('fetch', `Fetched ${page?.url || args}${page?.title ? ` — ${page.title}` : ''}. ${text}`, { url: page?.url, title: page?.title });
  }
  if (name === 'remember') {
    const [key, ...contentParts] = args.split('|');
    const content = contentParts.join('|').trim();
    if (!key?.trim() || !content) return fail('remember', 'Say remember key | content, or remember that X is Y.');
    const { CHAT_MEMORY_SCOPE, saveMemory } = await import('./agent-memory');
    const entry = saveMemory(CHAT_MEMORY_SCOPE, key.trim(), content, { source: 'manual', confidence: 1, status: 'active' }).entry;
    audit('chat', 'phone memory saved', entry.key, { memoryId: entry.id });
    return ok('remember', `Remembered ${entry.key}.`, { key: entry.key });
  }
  if (name === 'recall') {
    const { CHAT_MEMORY_SCOPE, recallMemories } = await import('./agent-memory');
    const entries = recallMemories(CHAT_MEMORY_SCOPE, args.trim() || undefined);
    if (!entries.length) return ok('recall', args ? `No memories matching ${args}.` : 'No memories saved yet.');
    return ok('recall', entries.slice(0, 8).map((entry) => `${entry.key}: ${entry.content.slice(0, 160)}`).join('; '), {
      keys: entries.map((entry) => entry.key),
    });
  }
  if (name === 'forget') {
    if (!args.trim()) return fail('forget', 'Which memory key should I delete?');
    const { CHAT_MEMORY_SCOPE, deleteMemoryByKey } = await import('./agent-memory');
    const removed = deleteMemoryByKey(CHAT_MEMORY_SCOPE, args.trim());
    if (removed) audit('chat', 'phone memory deleted', args.trim());
    return ok('forget', removed ? `Forgot ${args.trim()}.` : `No memory named ${args.trim()}.`, { removed });
  }
  if (name === 'note') {
    const [path, ...contentParts] = args.split('|');
    const content = contentParts.join('|').trim();
    if (!path?.trim() || !content) return fail('note', 'Usage: /note path | content.');
    if (path.includes('..')) return fail('note', 'Note path may not contain "..".');
    const { loadConfig } = await import('./persistence');
    await loadConfig();
    const { getIntegrationCreds, obsidianWriteNote } = await import('./integrations');
    const creds = getIntegrationCreds();
    const configured = creds.obsidian?.vaultPath?.trim() || (creds.obsidian?.restApiUrl?.trim() && creds.obsidian?.restApiKey?.trim());
    if (!configured) return fail('note', 'Obsidian is not configured on the Capabilities page.');
    const notePath = path.trim().endsWith('.md') ? path.trim() : `${path.trim()}.md`;
    await obsidianWriteNote(creds, notePath, content);
    audit('integration', 'phone obsidian note created', notePath);
    return ok('note', `Created Obsidian note ${notePath}.`, { path: notePath });
  }
  if (name === 'grok') {
    const intent = args.trim().toLowerCase() === 'login' ? 'login' : 'auto';
    const { launchGrokCliInPty } = await import('./terminal-server');
    const launched = await launchGrokCliInPty({ intent });
    if (!launched.ok) {
      return fail('grok', launched.error || 'Could not launch Grok Build in the Studio Terminal.');
    }
    audit('chat', 'phone launched grok cli in terminal', launched.launched || 'agent');
    return ok(
      'grok',
      launched.launched === 'login'
        ? 'I opened the Studio Terminal for Grok Build sign-in. Finish login on the host screen.'
        : 'I launched interactive Grok Build in the Studio Terminal. Look at the host screen.',
      { launched: launched.launched },
    );
  }
  if (name === 'x') {
    if (!args.trim()) return fail('x', 'What should I post to X?');
    const { loadConfig } = await import('./persistence');
    await loadConfig();
    const { xPostTweet } = await import('./integrations');
    const posted = await xPostTweet(args.trim());
    audit('integration', 'phone posted to X', args.trim().slice(0, 120), { url: posted.url });
    return ok('x', posted.url ? `Posted to X: ${posted.url}` : 'Posted to X.', { url: posted.url });
  }
  return fail(name, `I do not run ${name} from the phone.`);
}

export async function executePhoneCommand(utterance: string, opts: { record?: boolean } = {}): Promise<PhoneCommandResult> {
  const text = normalizeSpokenUtterance(utterance);
  if (!text) return fail('dictate_command', 'I did not catch a command.');
  let result: PhoneCommandResult;
  try {
    result = await executeResolved(resolveSpokenCommand(text));
  } catch (error) {
    result = fail('dictate_command', error instanceof Error ? error.message : 'Command failed.');
  }
  if (opts.record !== false) {
    try { await recordPhoneExchange(text, result); }
    catch (error) { console.error('[phone-assistant] failed to record chat exchange', error); }
  }
  return result;
}

export async function executePhoneTool(name: string, args: Record<string, unknown>, opts: { record?: boolean } = {}): Promise<PhoneCommandResult> {
  const tool = String(name || '').trim();
  const recordUtterance = () => {
    if (tool === 'dictate_command') return String(args.utterance || '');
    return `/${tool} ${JSON.stringify(args)}`;
  };
  let result: PhoneCommandResult;
  try {
    if (tool === 'dictate_command') result = await executePhoneCommand(String(args.utterance || ''), { record: false });
    else if (tool === 'create_task') result = await createBoardCard(String(args.title || ''), String(args.description || ''));
    else if (tool === 'list_board') result = await listBoard(String(args.query || ''));
    else if (tool === 'start_work') result = await startWork(String(args.brief || ''));
    else if (tool === 'git') result = await runGit({
      action: String(args.action || ''),
      branch: args.branch ? String(args.branch) : undefined,
      message: args.message ? String(args.message) : undefined,
      title: args.title ? String(args.title) : undefined,
      body: args.body ? String(args.body) : undefined,
      staged: !!args.staged,
      count: typeof args.count === 'number' ? args.count : undefined,
    });
    else if (tool === 'remember') result = await executeResolved({ name: 'remember', args: `${args.key || ''} | ${args.content || ''}` });
    else if (tool === 'recall') result = await executeResolved({ name: 'recall', args: String(args.query || '') });
    else if (tool === 'forget') result = await executeResolved({ name: 'forget', args: String(args.key || '') });
    else if (tool === 'search_web') result = await executeResolved({ name: 'search', args: String(args.query || '') });
    else if (tool === 'fetch_page') result = await executeResolved({ name: 'fetch', args: String(args.url || '') });
    else if (tool === 'studio_status') result = await studioStatus();
    else result = fail(tool, `Unknown phone tool ${tool}.`);
  } catch (error) {
    result = fail(tool, error instanceof Error ? error.message : 'Tool failed.');
  }
  if (opts.record !== false) {
    try { await recordPhoneExchange(recordUtterance(), result); }
    catch (error) { console.error('[phone-assistant] failed to record chat exchange', error); }
  }
  return result;
}
