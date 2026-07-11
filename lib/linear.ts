// Linear GraphQL adapter for Board sync. Credentials are always passed
// explicitly so concurrent agent runs cannot replace the account mid-sync.

import type { BoardPriority, BoardStatus, BoardSyncField, BoardTask } from './board-types';
import type {
  BoardProviderAdapter,
  BoardProviderSession,
  BoardSyncMode,
  BoardSyncTarget,
  RemoteBoardTask,
} from './board-sync-types';
import type { IntegrationCreds } from './types';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 100;

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

interface LinearState {
  id: string;
  name: string;
  type: string;
  position?: number;
}

interface LinearLabel {
  id: string;
  name: string;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: { id: string; name: string; type: string } | null;
  labels?: { nodes?: Array<{ id: string; name: string }> } | null;
}

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

function linearCreds(creds: IntegrationCreds): NonNullable<IntegrationCreds['linear']> {
  const cfg = creds.linear;
  if (!cfg?.apiKey?.trim()) throw new Error('Linear is not configured. Add an API key in Capabilities.');
  return cfg;
}

function linearAuthHeader(apiKey: string): string {
  const token = apiKey.trim();
  if (/^Bearer\s+/i.test(token)) return token;
  // Linear OAuth access tokens use Bearer auth; personal API keys are sent raw.
  return token.startsWith('lin_oauth_') ? `Bearer ${token}` : token;
}

function safeMessage(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || fallback;
}

function linearIssueUrl(value: unknown, identifier: string): string {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:' && (url.hostname === 'linear.app' || url.hostname.endsWith('.linear.app'))) {
      return url.toString();
    }
  } catch {
    // Fall through to the provider-owned issue route.
  }
  return `https://linear.app/issue/${encodeURIComponent(identifier)}`;
}

async function linearRequest<T>(
  creds: IntegrationCreds,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const cfg = linearCreds(creds);
  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: linearAuthHeader(cfg.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const createAttempt = query.includes('ShibaLinearIssueCreate');
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(createAttempt
        ? 'Linear create request timed out; check Linear for the issue before retrying.'
        : 'Linear request timed out.');
    }
    throw new Error(createAttempt
      ? 'Linear create request returned no response; check Linear for the issue before retrying.'
      : 'Could not reach Linear.');
  }

  const envelope = await response.json().catch(() => null) as GraphQlEnvelope<T> | null;
  if (!response.ok) {
    const message = envelope?.errors?.[0]?.message;
    throw new Error(`Linear API ${response.status}: ${safeMessage(message, response.statusText || 'request failed')}`);
  }
  if (envelope?.errors?.length) {
    throw new Error(`Linear: ${safeMessage(envelope.errors[0]?.message, 'GraphQL request failed')}`);
  }
  if (!envelope?.data) throw new Error('Linear returned an empty response.');
  return envelope.data;
}

export function linearStatusToBoard(type: string | undefined, name = ''): BoardStatus {
  const normalizedType = String(type || '').toLowerCase();
  const normalizedName = name.toLowerCase();
  if (normalizedType === 'completed') return 'done';
  if (normalizedType === 'canceled' || normalizedType === 'cancelled') return 'cancelled';
  if (normalizedType === 'triage' || normalizedType === 'backlog') return 'backlog';
  if (normalizedType === 'unstarted') return 'todo';
  if (/review|verify|validation|qa|test/.test(normalizedName)) return 'in_review';
  if (normalizedType === 'started') return 'in_progress';
  if (/cancel|duplicate|won't do|wont do/.test(normalizedName)) return 'cancelled';
  if (/done|complete|closed|resolved/.test(normalizedName)) return 'done';
  if (/backlog|triage/.test(normalizedName)) return 'backlog';
  if (/progress|doing|started/.test(normalizedName)) return 'in_progress';
  return 'todo';
}

function preferredState(states: LinearState[], status: BoardStatus): LinearState | undefined {
  const byName = (pattern: RegExp) => states.find((state) => pattern.test(state.name.toLowerCase()));
  const byType = (...types: string[]) => states.find((state) => types.includes(state.type.toLowerCase()));
  switch (status) {
    case 'backlog': return byName(/backlog|triage/) || byType('backlog', 'triage', 'unstarted');
    case 'todo': return byName(/^todo$|to do|ready|planned/) || byType('unstarted', 'backlog');
    case 'in_progress': return byName(/progress|doing|started/) || byType('started');
    case 'in_review': return byName(/review|verify|validation|qa|test/) || byType('started');
    case 'done': return byName(/done|complete|closed|resolved/) || byType('completed');
    case 'cancelled': return byName(/cancel|duplicate|won't do|wont do/) || byType('canceled', 'cancelled');
  }
}

function normalizeLinearIssue(issue: LinearIssueNode): RemoteBoardTask {
  const now = new Date().toISOString();
  const priority = Number(issue.priority);
  return {
    id: String(issue.id),
    key: String(issue.identifier || issue.id),
    title: String(issue.title || '(untitled)').slice(0, 300),
    description: String(issue.description || '').slice(0, 20_000),
    status: linearStatusToBoard(issue.state?.type, issue.state?.name),
    statusName: String(issue.state?.name || 'Todo'),
    priority: (Number.isInteger(priority) && priority >= 0 && priority <= 4 ? priority : 0) as BoardPriority,
    labels: (issue.labels?.nodes || []).map((label) => label.name).filter(Boolean).slice(0, 10),
    url: linearIssueUrl(issue.url, String(issue.identifier || issue.id)),
    createdAt: String(issue.createdAt || issue.updatedAt || now),
    updatedAt: String(issue.updatedAt || issue.createdAt || now),
  };
}

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  url
  createdAt
  updatedAt
  state { id name type }
  labels { nodes { id name } }
`;

export async function testLinear(
  creds: IntegrationCreds,
): Promise<{ ok: boolean; user?: string; organization?: string; teams?: LinearTeam[]; error?: string }> {
  try {
    const data = await linearRequest<{
      viewer: { id: string; name?: string; email?: string; organization?: { name?: string } };
      teams: { nodes: LinearTeam[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    }>(creds, `
      query ShibaLinearConnection {
        viewer { id name email organization { name } }
        teams(first: 100) { nodes { id key name } pageInfo { hasNextPage endCursor } }
      }
    `);
    const teams = [...(data.teams?.nodes || [])];
    let after = data.teams?.pageInfo?.endCursor || null;
    for (let page = 1; data.teams?.pageInfo?.hasNextPage && after && page < MAX_PAGES; page += 1) {
      const next = await linearRequest<{
        teams: { nodes: LinearTeam[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
      }>(creds, `
        query ShibaLinearTeams($after: String) {
          teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } }
        }
      `, { after });
      teams.push(...(next.teams?.nodes || []));
      data.teams.pageInfo = next.teams?.pageInfo;
      after = next.teams?.pageInfo?.endCursor || null;
    }
    if (data.teams?.pageInfo?.hasNextPage) {
      throw new Error(`Linear returned more than ${MAX_PAGES * 100} teams; target discovery was stopped safely.`);
    }
    return {
      ok: true,
      user: data.viewer?.name || data.viewer?.email,
      organization: data.viewer?.organization?.name,
      teams,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Linear connection failed.' };
  }
}

export async function linearDiscoverTargets(creds: IntegrationCreds): Promise<BoardSyncTarget[]> {
  const tested = await testLinear(creds);
  if (!tested.ok) throw new Error(tested.error || 'Linear connection failed.');
  return (tested.teams || []).map((team) => ({
    provider: 'linear',
    connectionId: 'linear',
    id: team.id,
    name: team.name,
    key: team.key,
    kind: 'team',
  }));
}

async function loadLinearTeamContext(creds: IntegrationCreds, teamId: string): Promise<{
  team: LinearTeam;
  states: LinearState[];
  labels: LinearLabel[];
}> {
  const data = await linearRequest<{
    team: LinearTeam & {
      states?: { nodes: LinearState[] };
      labels?: { nodes: LinearLabel[] };
    };
  }>(creds, `
    query ShibaLinearTeamContext($teamId: String!) {
      team(id: $teamId) {
        id
        key
        name
        states(first: 100) { nodes { id name type position } }
        labels(first: 100) { nodes { id name } }
      }
    }
  `, { teamId });
  if (!data.team?.id) throw new Error('Linear team was not found or is not accessible.');
  return {
    team: data.team,
    states: data.team.states?.nodes || [],
    labels: data.team.labels?.nodes || [],
  };
}

async function listLinearIssues(creds: IntegrationCreds, teamId: string): Promise<RemoteBoardTask[]> {
  const issues: RemoteBoardTask[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: {
      issues: {
        nodes: LinearIssueNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } = await linearRequest(creds, `
      query ShibaLinearIssues($teamId: ID!, $after: String) {
        issues(first: 100, after: $after, filter: { team: { id: { eq: $teamId } } }) {
          nodes { ${ISSUE_FRAGMENT} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { teamId, after });
    issues.push(...(data.issues?.nodes || []).map(normalizeLinearIssue));
    if (!data.issues?.pageInfo?.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`Linear returned more than ${MAX_PAGES * 100} issues. Narrow the team before syncing.`);
}

class LinearSession implements BoardProviderSession {
  readonly provider = 'linear' as const;
  private readonly labelsByName: Map<string, LinearLabel>;

  constructor(
    private readonly creds: IntegrationCreds,
    readonly target: BoardSyncTarget,
    private readonly team: LinearTeam,
    private readonly states: LinearState[],
    labels: LinearLabel[],
  ) {
    this.labelsByName = new Map(labels.map((label) => [label.name.toLowerCase(), label]));
  }

  listTasks(): Promise<RemoteBoardTask[]> {
    return listLinearIssues(this.creds, this.team.id);
  }

  private async labelIds(labels: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const raw of labels.slice(0, 10)) {
      const name = raw.trim();
      if (!name) continue;
      let label = this.labelsByName.get(name.toLowerCase());
      if (!label) {
        try {
          const data = await linearRequest<{
            issueLabelCreate: { success: boolean; issueLabel?: LinearLabel | null };
          }>(this.creds, `
            mutation ShibaLinearLabelCreate($input: IssueLabelCreateInput!) {
              issueLabelCreate(input: $input) { success issueLabel { id name } }
            }
          `, { input: { teamId: this.team.id, name: name.slice(0, 50), color: '#5E6AD2' } });
          if (data.issueLabelCreate?.success && data.issueLabelCreate.issueLabel) {
            label = data.issueLabelCreate.issueLabel;
            this.labelsByName.set(label.name.toLowerCase(), label);
          }
        } catch {
          // Label permissions vary by team. The issue itself should still sync.
        }
      }
      if (label) ids.push(label.id);
    }
    return ids;
  }

  private async inputFor(
    task: BoardTask,
    mode: BoardSyncMode,
    changedFields: BoardSyncField[] = ['title', 'description', 'status', 'priority', 'labels'],
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    if (changedFields.includes('title')) input.title = task.title.slice(0, 300);
    if (changedFields.includes('description')) input.description = task.description.slice(0, 20_000);
    if (changedFields.includes('priority')) input.priority = task.priority;
    if (changedFields.includes('labels')) input.labelIds = await this.labelIds(task.labels);
    if (mode === 'board' && changedFields.includes('status')) {
      const state = preferredState(this.states, task.status);
      if (!state) throw new Error(`Linear team has no workflow state matching Shiba status "${task.status}".`);
      input.stateId = state.id;
    }
    return input;
  }

  async createTask(
    task: BoardTask,
    mode: BoardSyncMode,
    onCreated?: (task: RemoteBoardTask, pendingFields: BoardSyncField[]) => Promise<void>,
  ): Promise<RemoteBoardTask> {
    const input = { teamId: this.team.id, ...(await this.inputFor(task, mode)) };
    const data = await linearRequest<{
      issueCreate: { success: boolean; issue?: LinearIssueNode | null };
    }>(this.creds, `
      mutation ShibaLinearIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_FRAGMENT} } }
      }
    `, { input });
    if (!data.issueCreate?.success || !data.issueCreate.issue) throw new Error('Linear did not create the issue.');
    const created = normalizeLinearIssue(data.issueCreate.issue);
    if (onCreated) await onCreated(created, []);
    return created;
  }

  async updateTask(
    remoteId: string,
    task: BoardTask,
    mode: BoardSyncMode,
    changedFields: BoardSyncField[],
  ): Promise<RemoteBoardTask> {
    const data = await linearRequest<{
      issueUpdate: { success: boolean; issue?: LinearIssueNode | null };
    }>(this.creds, `
      mutation ShibaLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FRAGMENT} } }
      }
    `, { id: remoteId, input: await this.inputFor(task, mode, changedFields) });
    if (!data.issueUpdate?.success || !data.issueUpdate.issue) throw new Error('Linear did not update the issue.');
    return normalizeLinearIssue(data.issueUpdate.issue);
  }
}

export const linearBoardAdapter: BoardProviderAdapter = {
  provider: 'linear',
  testConnection: testLinear,
  discoverTargets: linearDiscoverTargets,
  async createSession(creds, target) {
    if (target.provider !== 'linear' || target.kind !== 'team') throw new Error('Select a Linear team to sync.');
    const context = await loadLinearTeamContext(creds, target.id);
    const canonicalTarget: BoardSyncTarget = {
      provider: 'linear',
      connectionId: 'linear',
      id: context.team.id,
      name: context.team.name,
      key: context.team.key,
      kind: 'team',
    };
    return new LinearSession(creds, canonicalTarget, context.team, context.states, context.labels);
  },
};
