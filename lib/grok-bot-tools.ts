/**
 * Studio control-plane tools Grok Bot (and grok.com / Grok CLI HTTP MCP)
 * can call. These wrap shipped Board, agent, and task-ledger functions —
 * not a parallel executor.
 */

import { randomUUID } from 'node:crypto';
import { audit } from './audit-log';
import { dispatchExistingTask } from './background-tasks';
import {
  appendChatMessage,
  createChatSession,
  getChatSession,
  updateChatSession,
} from './chat-sessions';
import {
  GROK_BOT_CHAT_SESSION_ID,
  GROK_BOT_CHAT_TITLE,
} from './grok-bot';
import type { GrokBotToolDefinition, GrokBotToolResult } from './grok-bot-types';
import { recommendTaskMode } from './task-router';
import { createTask, getTaskDetails, listAttention, listTasks } from './task-ledger';

export type { GrokBotToolDefinition, GrokBotToolResult } from './grok-bot-types';

const MAX_DETAIL = 4_000;

export const GROK_BOT_TOOLS: GrokBotToolDefinition[] = [
  {
    name: 'studio_status',
    description: 'Summarize open Board cards, durable tasks waiting, and how many agents exist.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description: 'List Studio agents (id, name, model). Does not include credentials.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_board',
    description: 'List Board cards, optionally filtered by status or free text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Status (backlog, todo, in_progress, …) or free text.' } },
    },
  },
  {
    name: 'create_board_card',
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
    name: 'list_tasks',
    description: 'List open durable Studio tasks (queued, running, waiting for approval, paused).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows (1–50).' } },
    },
  },
  {
    name: 'get_task',
    description: 'Read one durable task by id: status, progress, open attention, and children.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'start_work',
    description: 'Create and dispatch a durable Studio task so a Studio agent works the brief in the background.',
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string', description: 'Complete outcome the agent should produce.' } },
      required: ['brief'],
    },
  },
  {
    name: 'list_attention',
    description: 'List open approval items the operator must confirm in Studio. Grok Bot cannot approve them.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
];

function fail(action: string, message: string, data?: Record<string, unknown>): GrokBotToolResult {
  return { ok: false, action, detail: message.slice(0, MAX_DETAIL), ...(data ? { data } : {}) };
}

function ok(action: string, message: string, data?: Record<string, unknown>): GrokBotToolResult {
  return { ok: true, action, detail: message.slice(0, MAX_DETAIL), ...(data ? { data } : {}) };
}

export async function ensureGrokBotChatSession(): Promise<{ id: string }> {
  const existing = await getChatSession(GROK_BOT_CHAT_SESSION_ID);
  if (existing) {
    if (existing.title !== GROK_BOT_CHAT_TITLE) {
      await updateChatSession(GROK_BOT_CHAT_SESSION_ID, { title: GROK_BOT_CHAT_TITLE }).catch(() => existing);
    }
    return existing;
  }
  return createChatSession({
    id: GROK_BOT_CHAT_SESSION_ID,
    title: GROK_BOT_CHAT_TITLE,
    chatTarget: 'grok',
  });
}

async function recordGrokBotExchange(label: string, result: GrokBotToolResult): Promise<void> {
  const session = await ensureGrokBotChatSession();
  const createdAt = new Date().toISOString();
  await appendChatMessage(session.id, {
    id: `grok-bot-user-${randomUUID()}`,
    role: 'user',
    content: label,
    createdAt,
  });
  await appendChatMessage(session.id, {
    id: `grok-bot-assistant-${randomUUID()}`,
    role: 'assistant',
    content: result.detail,
    agentName: GROK_BOT_CHAT_TITLE,
    createdAt: new Date().toISOString(),
  });
}

async function studioStatus(): Promise<GrokBotToolResult> {
  const { listBoardTasks } = await import('./board');
  const { loadAgents } = await import('./persistence');
  const [cards, agents] = await Promise.all([listBoardTasks(), loadAgents()]);
  const openCards = cards.filter((card) => !['done', 'cancelled'].includes(card.status)).slice(0, 8);
  const openTasks = listTasks({ statuses: ['queued', 'running', 'waiting_for_approval', 'paused'], limit: 8 }).tasks;
  const cardLine = openCards.length
    ? openCards.map((card) => `${card.key} ${card.title}`).join('; ')
    : 'no open board cards';
  const taskLine = openTasks.length
    ? openTasks.map((task) => `${task.status} ${task.title}`).join('; ')
    : 'no open durable tasks';
  return ok('studio_status', `Studio status. Agents: ${agents.length}. Board: ${cardLine}. Work: ${taskLine}.`, {
    agentCount: agents.length,
    boardOpen: openCards.length,
    tasksOpen: openTasks.length,
  });
}

async function listAgents(): Promise<GrokBotToolResult> {
  const { loadAgents } = await import('./persistence');
  const agents = (await loadAgents()).map((agent) => ({
    id: agent.id,
    name: agent.name,
    model: agent.model,
    description: agent.description || '',
    autoAcceptBoardAssignments: agent.autoAcceptBoardAssignments === true,
  }));
  if (!agents.length) return ok('list_agents', 'No agents are configured yet.', { agents: [], count: 0 });
  const lines = agents.map((agent) => `${agent.name} (${agent.id}, ${agent.model})`);
  return ok('list_agents', `Agents: ${lines.join('; ')}.`, { agents, count: agents.length });
}

async function listBoard(query = ''): Promise<GrokBotToolResult> {
  const { listBoardTasks } = await import('./board');
  const filter = query.trim().toLowerCase().replace(/\s+/g, '_');
  const statuses = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
  const tasks = (await listBoardTasks()).filter((task) => {
    if (!filter) return true;
    if (statuses.has(filter)) return task.status === filter;
    return [task.key, task.title, ...(task.labels || [])].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  }).slice(0, 20);
  if (!tasks.length) return ok('list_board', query ? `No Board cards matching ${query}.` : 'The board is empty.');
  const lines = tasks.map((task) => `${task.key} ${task.title} (${String(task.status).replace(/_/g, ' ')})`);
  return ok('list_board', `Board: ${lines.join('; ')}.`, {
    count: tasks.length,
    tasks: tasks.map((task) => ({ key: task.key, id: task.id, title: task.title, status: task.status })),
  });
}

async function createBoardCard(title: string, description = ''): Promise<GrokBotToolResult> {
  const trimmed = title.trim();
  if (!trimmed) return fail('create_board_card', 'A Board card title is required.');
  const { createBoardTask } = await import('./board');
  const task = await createBoardTask({ title: trimmed, description: description.trim(), status: 'backlog' });
  audit('config', 'grok bot board card created', `${task.key}: ${task.title.slice(0, 100)}`);
  return ok('create_board_card', `Created ${task.key}: ${task.title} in Backlog.`, {
    key: task.key,
    id: task.id,
    title: task.title,
    status: task.status,
  });
}

async function listOpenTasks(limit?: number): Promise<GrokBotToolResult> {
  const capped = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.trunc(Number(limit)))) : 20;
  const { tasks, total } = listTasks({
    statuses: ['queued', 'running', 'waiting_for_approval', 'paused', 'waiting_for_input', 'blocked'],
    limit: capped,
  });
  if (!tasks.length) return ok('list_tasks', 'No open durable tasks.', { tasks: [], total: 0 });
  const lines = tasks.map((task) => `${task.status} ${task.title} (${task.id})`);
  return ok('list_tasks', `Open tasks: ${lines.join('; ')}.`, {
    total,
    tasks: tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      title: task.title,
      progress: task.progress,
    })),
  });
}

async function getOneTask(taskId: string): Promise<GrokBotToolResult> {
  const id = taskId.trim();
  if (!id) return fail('get_task', 'task_id is required.');
  const details = getTaskDetails(id);
  if (!details) return fail('get_task', `No task with id ${id}.`);
  const attention = details.attention.map((item) => ({
    id: item.id,
    title: item.title,
    severity: item.severity,
    createdAt: item.createdAt,
  }));
  const children = details.children.map((child) => ({
    id: child.id,
    status: child.status,
    title: child.title,
  }));
  return ok('get_task', `${details.status} ${details.title} (${details.id}).`, {
    id: details.id,
    kind: details.kind,
    status: details.status,
    title: details.title,
    description: details.description.slice(0, 1_500),
    progress: details.progress,
    error: details.error || '',
    result: details.result ? String(details.result).slice(0, 1_500) : '',
    attention,
    children,
  });
}

async function startWork(brief: string): Promise<GrokBotToolResult> {
  const outcome = brief.replace(/\s+/g, ' ').trim();
  if (!outcome) return fail('start_work', 'Tell me what to work on.');
  const recommendation = recommendTaskMode({ outcome });
  const kind = recommendation.recommendedMode === 'code' ? 'code' : 'work';
  const session = await ensureGrokBotChatSession();
  const task = createTask({
    id: `grok-bot:${randomUUID()}`,
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
      constraints: ['This request was dispatched through the paired Grok Bot MCP connector.'],
      requiredArtifacts: [],
      requirements: [],
    },
    metadata: { grokBot: true, recommendation },
  });
  await dispatchExistingTask(task.id);
  audit('run', 'grok bot work dispatched', task.title, { taskId: task.id });
  return ok('start_work', `Started work: ${task.title}. Track it as task ${task.id}.`, {
    taskId: task.id,
    taskUrl: `/tasks/${encodeURIComponent(task.id)}`,
    kind,
  });
}

async function listOpenAttention(limit?: number): Promise<GrokBotToolResult> {
  const capped = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.trunc(Number(limit)))) : 20;
  const { items, total } = listAttention({ limit: capped });
  if (!items.length) return ok('list_attention', 'No open approvals. Studio is not waiting on the operator.', { items: [], total: 0 });
  const lines = items.map((item) => `${item.title} (${item.taskId})`);
  return ok('list_attention', `Waiting on Studio approval: ${lines.join('; ')}.`, {
    total,
    items: items.map((item) => ({
      id: item.id,
      taskId: item.taskId,
      title: item.title,
      body: String(item.body || '').slice(0, 400),
      severity: item.severity,
      createdAt: item.createdAt,
    })),
  });
}

export async function executeGrokBotTool(name: string, args: Record<string, unknown>): Promise<GrokBotToolResult> {
  const tool = String(name || '').trim();
  let result: GrokBotToolResult;
  try {
    if (tool === 'studio_status') result = await studioStatus();
    else if (tool === 'list_agents') result = await listAgents();
    else if (tool === 'list_board') result = await listBoard(String(args.query || ''));
    else if (tool === 'create_board_card') result = await createBoardCard(String(args.title || ''), String(args.description || ''));
    else if (tool === 'list_tasks') result = await listOpenTasks(args.limit as number | undefined);
    else if (tool === 'get_task') result = await getOneTask(String(args.task_id || args.taskId || ''));
    else if (tool === 'start_work') result = await startWork(String(args.brief || ''));
    else if (tool === 'list_attention') result = await listOpenAttention(args.limit as number | undefined);
    else result = fail(tool || 'unknown', `Unknown Grok Bot tool "${tool || '(empty)'}".`);
  } catch (error) {
    result = fail(tool || 'error', error instanceof Error ? error.message : 'Grok Bot tool failed');
  }
  await recordGrokBotExchange(`${tool} ${JSON.stringify(args)}`.slice(0, 500), result).catch(() => {});
  return result;
}
