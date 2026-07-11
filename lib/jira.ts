// Jira Cloud REST adapter for Board sync. Supports project-backed sync and
// Jira Software Kanban boards while keeping API-token credentials server-side.

import crypto from 'crypto';
import type { BoardPriority, BoardStatus, BoardSyncField, BoardTask } from './board-types';
import type {
  BoardProviderAdapter,
  BoardProviderSession,
  BoardSyncMode,
  BoardSyncTarget,
  RemoteBoardTask,
} from './board-sync-types';
import type { IntegrationCreds } from './types';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 100;
const ISSUE_FIELDS = 'summary,description,status,priority,labels,updated,created,project,issuetype';

interface JiraProject {
  id: string;
  key: string;
  name: string;
}

interface JiraBoard {
  id: number;
  name: string;
  type?: string;
  location?: {
    projectId?: number;
    projectKey?: string;
    projectName?: string;
    displayName?: string;
    name?: string;
  };
}

interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    created?: string;
    updated?: string;
    priority?: { id?: string; name?: string } | null;
    status?: {
      id?: string;
      name?: string;
      statusCategory?: { id?: number; key?: string; name?: string };
    } | null;
    project?: { id?: string; key?: string; name?: string };
  };
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { id?: string; name?: string; statusCategory?: { key?: string; name?: string } };
}

interface JiraStatusMapping {
  byId: Map<string, BoardStatus>;
  idsByStatus: Map<BoardStatus, Set<string>>;
}

class JiraHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'JiraHttpError';
  }
}

function jiraCreds(creds: IntegrationCreds): NonNullable<IntegrationCreds['jira']> {
  const cfg = creds.jira;
  if (!cfg?.baseUrl?.trim() || !cfg.email?.trim() || !cfg.apiToken?.trim()) {
    throw new Error('Jira is not configured. Add the site URL, email, and API token in Capabilities.');
  }
  return cfg;
}

function jiraBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Jira site URL is invalid.');
  }
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.atlassian.net')) {
    throw new Error('Jira Board sync supports HTTPS Jira Cloud sites on atlassian.net.');
  }
  if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the Jira Cloud site root, for example https://example.atlassian.net.');
  }
  return url.origin;
}

function jiraApiBaseUrl(cfg: NonNullable<IntegrationCreds['jira']>): string {
  const cloudId = cfg.cloudId?.trim();
  if (!cloudId) return jiraBaseUrl(cfg.baseUrl);
  if (!/^[A-Za-z0-9-]{8,100}$/.test(cloudId)) throw new Error('Jira Cloud ID is invalid.');
  return `https://api.atlassian.com/ex/jira/${cloudId}`;
}

function jiraConnectionId(cfg: NonNullable<IntegrationCreds['jira']>): string {
  return `jira-${crypto.createHash('sha256').update(jiraBaseUrl(cfg.baseUrl)).digest('hex').slice(0, 20)}`;
}

function safeMessage(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || fallback;
}

function jiraErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const data = body as Record<string, unknown>;
  if (typeof data.message === 'string') return data.message;
  if (Array.isArray(data.errorMessages) && data.errorMessages.length) return String(data.errorMessages[0]);
  if (data.errors && typeof data.errors === 'object') {
    const first = Object.values(data.errors as Record<string, unknown>)[0];
    if (first) return String(first);
  }
  return fallback;
}

async function jiraRequest<T>(
  creds: IntegrationCreds,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const cfg = jiraCreds(creds);
  const baseUrl = jiraApiBaseUrl(cfg);
  const auth = Buffer.from(`${cfg.email.trim()}:${cfg.apiToken.trim()}`, 'utf8').toString('base64');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const createAttempt = path === '/rest/api/3/issue' && String(init.method || 'GET').toUpperCase() === 'POST';
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(createAttempt
        ? 'Jira create request timed out; check Jira for the issue before retrying.'
        : 'Jira request timed out.');
    }
    throw new Error(createAttempt
      ? 'Jira create request returned no response; check Jira for the issue before retrying.'
      : 'Could not reach Jira.');
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!response.ok) {
    const detail = jiraErrorMessage(body, response.statusText || 'request failed');
    throw new JiraHttpError(response.status, `Jira API ${response.status}: ${safeMessage(detail, 'request failed')}`);
  }
  return body as T;
}

async function validateJiraSite(creds: IntegrationCreds): Promise<string> {
  const cfg = jiraCreds(creds);
  const expected = jiraBaseUrl(cfg.baseUrl);
  const info = await jiraRequest<{ baseUrl?: string }>(creds, '/rest/api/3/serverInfo');
  if (!info.baseUrl || jiraBaseUrl(info.baseUrl) !== expected) {
    throw new Error('The Jira connection does not match the configured Jira site URL.');
  }
  return expected;
}

function adfText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(adfText).join('');
  if (typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'mention' && node.attrs?.text) return node.attrs.text;
  if (node.type === 'hardBreak') return '\n';
  const content = (node.content || []).map(adfText).join('');
  return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem'
    ? `${content}\n`
    : content;
}

function toAdf(text: string): Record<string, unknown> {
  const lines = text.slice(0, 20_000).split(/\r?\n/);
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

export function jiraStatusToBoard(category: string | undefined, name = ''): BoardStatus {
  const normalizedCategory = String(category || '').toLowerCase();
  const normalizedName = name.toLowerCase();
  if (/cancel|duplicate|won't do|wont do|rejected/.test(normalizedName)) return 'cancelled';
  if (/review|verify|validation|qa|test|approval/.test(normalizedName)) return 'in_review';
  if (/backlog|triage|icebox/.test(normalizedName)) return 'backlog';
  if (normalizedCategory === 'done' || /done|complete|closed|resolved/.test(normalizedName)) return 'done';
  if (normalizedCategory === 'indeterminate' || /progress|doing|started/.test(normalizedName)) return 'in_progress';
  return 'todo';
}

export function jiraPriorityToBoard(name: string | undefined): BoardPriority {
  const normalized = String(name || '').toLowerCase();
  if (/highest|urgent|blocker|critical/.test(normalized)) return 1;
  if (/high|major/.test(normalized)) return 2;
  if (/medium|normal/.test(normalized)) return 3;
  if (/low|minor|trivial/.test(normalized)) return 4;
  return 0;
}

function boardPriorityToJira(priority: BoardPriority): string | undefined {
  if (priority === 1) return 'Highest';
  if (priority === 2) return 'High';
  if (priority === 3) return 'Medium';
  if (priority === 4) return 'Low';
  return undefined;
}

function normalizeJiraIssue(
  issue: JiraIssue,
  baseUrl: string,
  statusMapping?: JiraStatusMapping,
): RemoteBoardTask {
  const fields = issue.fields || {};
  const now = new Date().toISOString();
  return {
    id: String(issue.id),
    key: String(issue.key || issue.id),
    title: String(fields.summary || '(untitled)').slice(0, 300),
    description: adfText(fields.description).trim().slice(0, 20_000),
    status: (fields.status?.id ? statusMapping?.byId.get(fields.status.id) : undefined)
      || jiraStatusToBoard(fields.status?.statusCategory?.key, fields.status?.name),
    statusName: String(fields.status?.name || 'To Do'),
    priority: jiraPriorityToBoard(fields.priority?.name),
    labels: (fields.labels || []).map(String).filter(Boolean).slice(0, 10),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    createdAt: String(fields.created || fields.updated || now),
    updatedAt: String(fields.updated || fields.created || now),
  };
}

async function listProjects(creds: IntegrationCreds): Promise<JiraProject[]> {
  const projects: JiraProject[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: '100', orderBy: 'name' });
    const data = await jiraRequest<{
      values?: JiraProject[];
      total?: number;
      maxResults?: number;
      isLast?: boolean;
    }>(creds, `/rest/api/3/project/search?${params}`);
    const values = data.values || [];
    projects.push(...values);
    if (
      data.isLast
      || values.length === 0
      || (typeof data.total === 'number' && projects.length >= data.total)
    ) return projects;
    startAt += Number(data.maxResults || values.length || 100);
  }
  throw new Error(`Jira returned more than ${MAX_PAGES * 100} projects; target discovery was stopped safely.`);
}

async function listBoards(creds: IntegrationCreds): Promise<JiraBoard[]> {
  const boards: JiraBoard[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      type: 'kanban',
      startAt: String(startAt),
      maxResults: '100',
    });
    const data = await jiraRequest<{
      values?: JiraBoard[];
      total?: number;
      startAt?: number;
      maxResults?: number;
      isLast?: boolean;
    }>(creds, `/rest/agile/1.0/board?${params}`);
    const values = data.values || [];
    boards.push(...values);
    if (
      data.isLast
      || values.length === 0
      || (typeof data.total === 'number' && boards.length >= data.total)
    ) return boards;
    startAt += Number(data.maxResults || values.length || 100);
  }
  throw new Error(`Jira returned more than ${MAX_PAGES * 100} Kanban boards; target discovery was stopped safely.`);
}

export async function testJira(creds: IntegrationCreds): Promise<{
  ok: boolean;
  user?: string;
  site?: string;
  projects?: JiraProject[];
  boards?: JiraBoard[];
  error?: string;
}> {
  try {
    const cfg = jiraCreds(creds);
    await validateJiraSite(creds);
    const user = await jiraRequest<{ displayName?: string; emailAddress?: string }>(creds, '/rest/api/3/myself');
    const projects = await listProjects(creds);
    let boards: JiraBoard[] = [];
    try {
      boards = await listBoards(creds);
    } catch (error) {
      // Jira Work Management sites may not expose Jira Software boards.
      if (!(error instanceof JiraHttpError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
    return {
      ok: true,
      user: user.displayName || user.emailAddress || cfg.email,
      site: jiraBaseUrl(cfg.baseUrl),
      projects,
      boards,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Jira connection failed.' };
  }
}

export async function jiraDiscoverTargets(creds: IntegrationCreds): Promise<BoardSyncTarget[]> {
  const tested = await testJira(creds);
  if (!tested.ok) throw new Error(tested.error || 'Jira connection failed.');
  const connectionId = jiraConnectionId(jiraCreds(creds));
  const projects: BoardSyncTarget[] = (tested.projects || []).map((project) => ({
    provider: 'jira',
    connectionId,
    id: `project:${project.key}`,
    key: project.key,
    name: project.name,
    projectKey: project.key,
    projectName: project.name,
    kind: 'project',
  }));
  const boards: BoardSyncTarget[] = (tested.boards || []).map((board) => ({
    provider: 'jira',
    connectionId,
    id: `board:${board.id}`,
    name: board.name,
    kind: 'board',
    projectKey: board.location?.projectKey,
    projectName: board.location?.projectName || board.location?.displayName || board.location?.name,
  }));
  return [...boards, ...projects];
}

function projectJql(projectKey: string, extra?: string): string {
  const key = projectKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Select a valid Jira project before syncing.');
  const base = `project = "${key}"`;
  return extra?.trim() ? `${base} AND (${extra.trim()}) ORDER BY updated DESC` : `${base} ORDER BY updated DESC`;
}

async function listProjectIssues(
  creds: IntegrationCreds,
  projectKey: string,
  extraJql?: string,
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      jql: projectJql(projectKey, extraJql),
      maxResults: '100',
      fields: ISSUE_FIELDS,
    });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const data = await jiraRequest<{
      issues?: JiraIssue[];
      isLast?: boolean;
      nextPageToken?: string;
    }>(creds, `/rest/api/3/search/jql?${params}`);
    issues.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) return issues;
    nextPageToken = data.nextPageToken;
  }
  throw new Error(`Jira returned more than ${MAX_PAGES * 100} project issues. Narrow the optional JQL before syncing.`);
}

async function listBoardIssues(
  creds: IntegrationCreds,
  boardId: string,
  extraJql?: string,
): Promise<JiraIssue[]> {
  if (!/^\d+$/.test(boardId)) throw new Error('Select a valid Jira Kanban board before syncing.');
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ maxResults: '100', fields: ISSUE_FIELDS });
      if (extraJql?.trim()) params.set('jql', extraJql.trim());
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const data = await jiraRequest<{
        issues?: JiraIssue[];
        isLast?: boolean;
        nextPageToken?: string;
      }>(creds, `/rest/software/1.0/board/${encodeURIComponent(boardId)}/issue?${params}`);
      issues.push(...(data.issues || []));
      if (data.isLast || !data.nextPageToken) return issues;
      nextPageToken = data.nextPageToken;
    }
    throw new Error(`Jira returned more than ${MAX_PAGES * 100} board issues. Narrow the optional JQL before syncing.`);
  } catch (error) {
    if (!(error instanceof JiraHttpError) || error.status !== 404) throw error;
    issues.length = 0;
  }

  // Compatibility fallback while Atlassian rolls out the token-paginated endpoint.
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: '100', fields: ISSUE_FIELDS });
    if (extraJql?.trim()) params.set('jql', extraJql.trim());
    const data = await jiraRequest<{ issues?: JiraIssue[]; total?: number; maxResults?: number }>(
      creds,
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?${params}`,
    );
    const pageIssues = data.issues || [];
    issues.push(...pageIssues);
    startAt += Number(data.maxResults || pageIssues.length || 100);
    if (
      !pageIssues.length
      || (typeof data.total === 'number' && startAt >= data.total)
      || (typeof data.total !== 'number' && pageIssues.length < Number(data.maxResults || 100))
    ) return issues;
  }
  throw new Error(`Jira returned more than ${MAX_PAGES * 100} board issues. Narrow the optional JQL before syncing.`);
}

function normalizedLabels(labels: string[]): string[] {
  return labels.slice(0, 10).map((label) =>
    label.trim().replace(/\s+/g, '-').replace(/[^\w.-]/g, '').slice(0, 255),
  ).filter(Boolean);
}

function transitionScore(
  transition: JiraTransition,
  status: BoardStatus,
  preferredStatusIds?: Set<string>,
): number {
  const name = String(transition.to?.name || transition.name || '').toLowerCase();
  const category = String(transition.to?.statusCategory?.key || '').toLowerCase();
  const mapped = jiraStatusToBoard(category, name);
  let score = mapped === status ? 20 : 0;
  if (transition.to?.id && preferredStatusIds?.has(transition.to.id)) score += 100;
  const patterns: Record<BoardStatus, RegExp> = {
    backlog: /backlog|triage|icebox/,
    todo: /^todo$|to do|open|ready|selected/,
    in_progress: /progress|doing|started/,
    in_review: /review|verify|validation|qa|test|approval/,
    done: /done|complete|closed|resolved/,
    cancelled: /cancel|duplicate|won't do|wont do|rejected/,
  };
  if (patterns[status].test(name)) score += 30;
  return score;
}

function addStatusMapping(mapping: JiraStatusMapping, id: string, status: BoardStatus): void {
  if (!id) return;
  mapping.byId.set(id, status);
  const ids = mapping.idsByStatus.get(status) || new Set<string>();
  ids.add(id);
  mapping.idsByStatus.set(status, ids);
}

async function loadStatusMapping(
  creds: IntegrationCreds,
  target: BoardSyncTarget,
): Promise<JiraStatusMapping> {
  const mapping: JiraStatusMapping = { byId: new Map(), idsByStatus: new Map() };
  try {
    if (target.kind === 'board') {
      const boardId = target.id.replace(/^board:/, '');
      const data = await jiraRequest<{
        columnConfig?: {
          columns?: Array<{ name?: string; statuses?: Array<{ id?: string; name?: string }> }>;
        };
      }>(creds, `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`);
      for (const column of data.columnConfig?.columns || []) {
        for (const status of column.statuses || []) {
          addStatusMapping(
            mapping,
            String(status.id || ''),
            jiraStatusToBoard(undefined, `${status.name || ''} ${column.name || ''}`),
          );
        }
      }
    } else {
      const projectKey = target.projectKey || target.key || '';
      const issueTypes = await jiraRequest<Array<{
        statuses?: Array<{
          id?: string;
          name?: string;
          statusCategory?: { key?: string };
        }>;
      }>>(creds, `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
      for (const issueType of issueTypes || []) {
        for (const status of issueType.statuses || []) {
          addStatusMapping(
            mapping,
            String(status.id || ''),
            jiraStatusToBoard(status.statusCategory?.key, status.name),
          );
        }
      }
    }
  } catch {
    // Status discovery is advisory. Name/category mapping remains available.
  }
  return mapping;
}

async function loadPriorityIds(creds: IntegrationCreds): Promise<Map<BoardPriority, string>> {
  const result = new Map<BoardPriority, string>();
  try {
    const data = await jiraRequest<{ values?: Array<{ id?: string; name?: string }> }>(
      creds,
      '/rest/api/3/priority/search?maxResults=100',
    );
    for (const priority of data.values || []) {
      const mapped = jiraPriorityToBoard(priority.name);
      if (mapped && priority.id && !result.has(mapped)) result.set(mapped, priority.id);
    }
  } catch {
    // Standard Jira priority names are used as the compatibility fallback.
  }
  return result;
}

async function loadIssueType(
  creds: IntegrationCreds,
  projectKey: string | undefined,
  wantedName: string | undefined,
): Promise<{ id?: string; name: string }> {
  const wanted = wantedName?.trim() || 'Task';
  if (!projectKey) return { name: wanted };
  try {
    const data = await jiraRequest<{
      values?: Array<{ id?: string; name?: string; subtask?: boolean }>;
    }>(creds, `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`);
    const types = (data.values || []).filter((type) => !type.subtask);
    const match = types.find((type) => type.name?.toLowerCase() === wanted.toLowerCase())
      || types.find((type) => type.name?.toLowerCase() === 'task')
      || types[0];
    if (match?.id) return { id: match.id, name: match.name || wanted };
  } catch {
    // The configured issue-type name remains a supported Jira create input.
  }
  return { name: wanted };
}

class JiraSession implements BoardProviderSession {
  readonly provider = 'jira' as const;
  private readonly cfg: NonNullable<IntegrationCreds['jira']>;
  private readonly baseUrl: string;

  constructor(
    private readonly creds: IntegrationCreds,
    readonly target: BoardSyncTarget,
    private readonly statusMapping: JiraStatusMapping,
    private readonly priorityIds: Map<BoardPriority, string>,
    private readonly issueType: { id?: string; name: string },
  ) {
    this.cfg = jiraCreds(creds);
    this.baseUrl = jiraBaseUrl(this.cfg.baseUrl);
  }

  async listTasks(): Promise<RemoteBoardTask[]> {
    const raw = this.target.kind === 'board'
      ? await listBoardIssues(this.creds, this.target.id.replace(/^board:/, ''), this.cfg.jql)
      : await listProjectIssues(this.creds, this.target.projectKey || this.target.key || '', this.cfg.jql);
    return raw.map((issue) => normalizeJiraIssue(issue, this.baseUrl, this.statusMapping));
  }

  private fieldsFor(
    task: BoardTask,
    changedFields: BoardSyncField[] = ['title', 'description', 'priority', 'labels'],
    clearNoPriority = false,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (changedFields.includes('title')) fields.summary = task.title.slice(0, 255);
    if (changedFields.includes('description')) fields.description = toAdf(task.description);
    if (changedFields.includes('labels')) fields.labels = normalizedLabels(task.labels);
    if (changedFields.includes('priority')) {
      const priority = boardPriorityToJira(task.priority);
      const priorityId = this.priorityIds.get(task.priority);
      if (priorityId) fields.priority = { id: priorityId };
      else if (priority) fields.priority = { name: priority };
      else if (clearNoPriority) fields.priority = null;
    }
    return fields;
  }

  private async getIssue(idOrKey: string): Promise<JiraIssue> {
    return jiraRequest<JiraIssue>(
      this.creds,
      `/rest/api/3/issue/${encodeURIComponent(idOrKey)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`,
    );
  }

  private async transition(idOrKey: string, status: BoardStatus, startingStatus: BoardStatus): Promise<void> {
    const rank: Record<BoardStatus, number> = {
      backlog: 0,
      todo: 1,
      in_progress: 2,
      in_review: 3,
      done: 4,
      cancelled: 5,
    };
    let currentStatus = startingStatus;
    for (let step = 0; step < 6; step += 1) {
      const data = await jiraRequest<{ transitions?: JiraTransition[] }>(
        this.creds,
        `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`,
      );
      const candidates = (data.transitions || []).map((transition) => {
        const name = String(transition.to?.name || transition.name || '');
        const mapped = transition.to?.id
          ? this.statusMapping.byId.get(transition.to.id)
          : undefined;
        const nextStatus = mapped || jiraStatusToBoard(transition.to?.statusCategory?.key, name);
        const directScore = transitionScore(transition, status, this.statusMapping.idsByStatus.get(status));
        const movingUp = rank[status] >= rank[currentStatus];
        const overshoots = movingUp ? rank[nextStatus] > rank[status] : rank[nextStatus] < rank[status];
        return {
          transition,
          nextStatus,
          score: directScore * 100 - Math.abs(rank[nextStatus] - rank[status]) * 10 - (overshoots ? 5 : 0),
        };
      }).filter((entry) => entry.nextStatus !== currentStatus);
      candidates.sort((a, b) => b.score - a.score);
      const selected = candidates[0];
      if (!selected) throw new Error(`Jira has no available transition toward Shiba status "${status}".`);
      await jiraRequest<void>(this.creds, `/rest/api/3/issue/${encodeURIComponent(idOrKey)}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: selected.transition.id } }),
      });
      currentStatus = selected.nextStatus;
      if (currentStatus === status) return;
    }
    throw new Error(`Jira could not reach Shiba status "${status}" within six workflow transitions.`);
  }

  async createTask(
    task: BoardTask,
    mode: BoardSyncMode,
    onCreated?: (task: RemoteBoardTask, pendingFields: BoardSyncField[]) => Promise<void>,
  ): Promise<RemoteBoardTask> {
    const projectKey = this.target.projectKey || this.cfg.projectKey;
    if (!projectKey) throw new Error('The selected Jira board has no project. Choose a project-backed Kanban board.');
    const created = await jiraRequest<{ id: string; key: string }>(this.creds, '/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: this.issueType.id ? { id: this.issueType.id } : { name: this.issueType.name },
          ...this.fieldsFor(task),
        },
      }),
    });
    const now = new Date().toISOString();
    const provisional: RemoteBoardTask = {
      id: created.id,
      key: created.key,
      title: task.title,
      description: task.description,
      status: mode === 'board' ? 'todo' : task.status,
      statusName: mode === 'board' ? 'To Do' : task.status,
      priority: task.priority,
      labels: normalizedLabels(task.labels),
      url: `${this.baseUrl}/browse/${encodeURIComponent(created.key)}`,
      createdAt: now,
      updatedAt: now,
    };
    if (onCreated) await onCreated(provisional, mode === 'board' ? ['status'] : []);
    const current = await this.getIssue(created.key || created.id);
    const normalized = normalizeJiraIssue(current, this.baseUrl, this.statusMapping);
    if (mode === 'board' && normalized.status !== task.status) {
      await this.transition(created.key || created.id, task.status, normalized.status);
    }
    return normalizeJiraIssue(await this.getIssue(created.key || created.id), this.baseUrl, this.statusMapping);
  }

  async updateTask(
    remoteId: string,
    task: BoardTask,
    mode: BoardSyncMode,
    changedFields: BoardSyncField[],
  ): Promise<RemoteBoardTask> {
    const before = await this.getIssue(remoteId);
    const fields = this.fieldsFor(task, changedFields, true);
    if (Object.keys(fields).length) {
      await jiraRequest<void>(this.creds, `/rest/api/3/issue/${encodeURIComponent(remoteId)}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });
    }
    if (mode === 'board' && changedFields.includes('status')) {
      const current = normalizeJiraIssue(before, this.baseUrl, this.statusMapping);
      if (current.status !== task.status) await this.transition(remoteId, task.status, current.status);
    }
    return normalizeJiraIssue(await this.getIssue(remoteId), this.baseUrl, this.statusMapping);
  }
}

export const jiraBoardAdapter: BoardProviderAdapter = {
  provider: 'jira',
  testConnection: testJira,
  discoverTargets: jiraDiscoverTargets,
  async createSession(creds, target) {
    if (target.provider !== 'jira' || (target.kind !== 'project' && target.kind !== 'board')) {
      throw new Error('Select a Jira project or Kanban board to sync.');
    }
    const cfg = jiraCreds(creds);
    await validateJiraSite(creds);
    const projectKey = target.projectKey || target.key || cfg.projectKey;
    const [statusMapping, priorityIds, issueType] = await Promise.all([
      loadStatusMapping(creds, target),
      loadPriorityIds(creds),
      loadIssueType(creds, projectKey, cfg.issueType),
    ]);
    return new JiraSession(
      creds,
      { ...target, connectionId: jiraConnectionId(cfg) },
      statusMapping,
      priorityIds,
      issueType,
    );
  },
};
