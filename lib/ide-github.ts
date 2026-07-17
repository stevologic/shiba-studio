import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWorkspace } from './workspace';

const execFileAsync = promisify(execFile);
const GIT_READ_TIMEOUT_MS = 30_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 60_000;
const MAX_BRANCH_CHARS = 250;

export interface IdeGitHubRepository {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch?: string;
  private?: boolean;
  description?: string | null;
}

export interface IdeGitHubPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  updatedAt: string;
}

export interface IdeGitHubIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

export interface IdeGitHubWorkflowRun {
  id: number;
  name: string;
  url: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}

export interface IdeGitHubSnapshot {
  configured: boolean;
  connected: boolean;
  login?: string;
  repository?: IdeGitHubRepository;
  pullRequests: IdeGitHubPullRequest[];
  issues: IdeGitHubIssue[];
  workflowRuns: IdeGitHubWorkflowRun[];
  error?: string;
  actionsError?: string;
}

export class IdeGitHubError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'IDE_GITHUB_FAILED', status = 409) {
    super(message);
    this.name = 'IdeGitHubError';
    this.code = code;
    this.status = status;
  }
}

type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

async function git(
  workspace: string,
  args: string[],
  timeoutMs = GIT_READ_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd: resolveWorkspace(workspace),
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { stdout, stderr, code: 0, timedOut: false };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
      killed?: boolean;
    };
    return {
      stdout: failure.stdout || '',
      stderr: failure.stderr || failure.message || String(error),
      code: typeof failure.code === 'number' ? failure.code : 1,
      timedOut: failure.killed === true || failure.code === 'ETIMEDOUT',
    };
  }
}

export function parseGitHubRemote(remote: string): IdeGitHubRepository | null {
  const value = String(remote || '').trim();
  if (!value) return null;

  let owner = '';
  let name = '';
  const scp = value.match(/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)\/?$/i);
  if (scp) {
    owner = scp[1];
    name = scp[2];
  } else {
    try {
      const parsed = new URL(value.replace(/^git\+/i, ''));
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol.toLowerCase())) {
        return null;
      }
      if (parsed.hostname.toLowerCase() !== 'github.com') return null;
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length !== 2) return null;
      [owner, name] = segments;
    } catch {
      return null;
    }
  }

  try {
    owner = decodeURIComponent(owner);
    name = decodeURIComponent(name).replace(/\.git$/i, '');
  } catch {
    return null;
  }
  if (
    owner.length > 100
    || name.length > 100
    || owner === '.'
    || owner === '..'
    || name === '.'
    || name === '..'
    || !/^[A-Za-z0-9_.-]+$/.test(owner)
    || !/^[A-Za-z0-9_.-]+$/.test(name)
  ) {
    return null;
  }
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

export async function resolveGitHubRepository(workspace: string): Promise<IdeGitHubRepository | null> {
  const result = await git(workspace, ['remote', 'get-url', 'origin']);
  if (result.code !== 0) return null;
  return parseGitHubRemote(result.stdout);
}

async function createOctokit(token: string) {
  const { Octokit } = await import('octokit');
  return new Octokit({
    auth: token,
    request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
  });
}

export function redactIdeGitHubText(value: unknown, secrets: readonly string[] = []): string {
  let output = String(value || '');
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed) output = output.split(trimmed).join('[redacted]');
  }
  return output
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+(?::[^/@\s]*)?)@/g, '$1[redacted]@')
    .replace(/\b[^@\s/:]+@github\.com:/gi, '[redacted]@github.com:')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .slice(0, 600);
}

function errorMessage(error: unknown, token?: string): string {
  const value = error instanceof Error ? error.message : error || 'GitHub request failed';
  return redactIdeGitHubText(value, token ? [token] : []);
}

function githubRequestError(
  error: unknown,
  fallback: string,
  token?: string,
): IdeGitHubError {
  if (error instanceof IdeGitHubError) return error;
  const rawStatus = Number((error as { status?: unknown } | null)?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : 502;
  const message = errorMessage(error, token) || fallback;
  return new IdeGitHubError(message, 'GITHUB_REQUEST_FAILED', status);
}

function requiredText(value: string, label: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new IdeGitHubError(`${label} is required.`, 'GITHUB_TEXT_REQUIRED', 400);
  }
  if (trimmed.length > maxChars || trimmed.includes('\0')) {
    throw new IdeGitHubError(
      `${label} must be ${maxChars.toLocaleString()} characters or fewer.`,
      'GITHUB_TEXT_TOO_LONG',
      400,
    );
  }
  return trimmed;
}

function optionalText(value: string | undefined, label: string, maxChars: number): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return requiredText(value, label, maxChars);
}

function gitFailureMessage(result: GitResult, fallback: string, token?: string): string {
  return redactIdeGitHubText(
    (result.stderr || result.stdout || fallback).trim(),
    token ? [token] : [],
  ) || fallback;
}

export async function getIdeGitHubSnapshot(
  workspace: string,
  token?: string,
): Promise<IdeGitHubSnapshot> {
  const repository = await resolveGitHubRepository(workspace);
  const configured = !!token?.trim();
  const empty: IdeGitHubSnapshot = {
    configured,
    connected: false,
    repository: repository || undefined,
    pullRequests: [],
    issues: [],
    workflowRuns: [],
  };

  if (!repository) {
    return { ...empty, error: 'The origin remote is not a GitHub repository.' };
  }
  if (!configured) {
    return { ...empty, error: 'Connect GitHub in Capabilities to browse repository activity.' };
  }

  try {
    const octokit = await createOctokit(token!.trim());
    const [viewer, repo] = await Promise.all([
      octokit.rest.users.getAuthenticated(),
      octokit.rest.repos.get({ owner: repository.owner, repo: repository.name }),
    ]);
    const [pullsResult, issuesResult, runsResult] = await Promise.allSettled([
      octokit.rest.pulls.list({
        owner: repository.owner,
        repo: repository.name,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 12,
      }),
      octokit.rest.issues.listForRepo({
        owner: repository.owner,
        repo: repository.name,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 20,
      }),
      octokit.rest.actions.listWorkflowRunsForRepo({
        owner: repository.owner,
        repo: repository.name,
        per_page: 8,
      }),
    ]);

    const pullRequests = pullsResult.status === 'fulfilled'
      ? pullsResult.value.data.map((pull) => ({
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          author: pull.user?.login || 'unknown',
          head: pull.head.ref,
          base: pull.base.ref,
          draft: !!pull.draft,
          updatedAt: pull.updated_at || '',
        }))
      : [];
    const issues = issuesResult.status === 'fulfilled'
      ? issuesResult.value.data
          .filter((issue) => !issue.pull_request)
          .slice(0, 12)
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            author: issue.user?.login || 'unknown',
            labels: issue.labels
              .map((label) => (typeof label === 'string' ? label : label.name || ''))
              .filter(Boolean),
            assignees: (issue.assignees || []).map((assignee) => assignee.login),
            updatedAt: issue.updated_at || '',
          }))
      : [];
    const workflowRuns = runsResult.status === 'fulfilled'
      ? runsResult.value.data.workflow_runs.map((run) => ({
          id: run.id,
          name: run.name || run.display_title || 'Workflow',
          url: run.html_url,
          branch: run.head_branch || '',
          event: run.event,
          status: run.status || 'unknown',
          conclusion: run.conclusion || null,
          updatedAt: run.updated_at || '',
        }))
      : [];

    return {
      configured: true,
      connected: true,
      login: viewer.data.login,
      repository: {
        ...repository,
        defaultBranch: repo.data.default_branch,
        private: repo.data.private,
        description: repo.data.description,
      },
      pullRequests,
      issues,
      workflowRuns,
      actionsError: runsResult.status === 'rejected' ? errorMessage(runsResult.reason, token) : undefined,
    };
  } catch (error) {
    return { ...empty, error: errorMessage(error, token) };
  }
}

async function requireRepositoryAndToken(workspace: string, token?: string) {
  const repository = await resolveGitHubRepository(workspace);
  if (!repository) {
    throw new IdeGitHubError(
      'The origin remote is not a GitHub repository.',
      'GITHUB_ORIGIN_REQUIRED',
      400,
    );
  }
  if (!token?.trim()) {
    throw new IdeGitHubError(
      'Connect GitHub in Capabilities first.',
      'GITHUB_NOT_CONFIGURED',
      401,
    );
  }
  return { repository, octokit: await createOctokit(token.trim()) };
}

export async function createIdeGitHubPullRequest(input: {
  workspace: string;
  token?: string;
  title: string;
  body?: string;
  base?: string;
}): Promise<{ number: number; url: string }> {
  const title = requiredText(input.title, 'Pull request title', MAX_TITLE_CHARS);
  const body = optionalText(input.body, 'Pull request body', MAX_BODY_CHARS);
  const requestedBase = optionalText(
    input.base,
    'Pull request base branch',
    MAX_BRANCH_CHARS,
  );
  const { repository, octokit } = await requireRepositoryAndToken(input.workspace, input.token);

  const branchResult = await git(input.workspace, ['branch', '--show-current']);
  const branch = branchResult.stdout.trim();
  if (branchResult.timedOut) {
    throw new IdeGitHubError('Git branch detection timed out.', 'GIT_TIMEOUT', 504);
  }
  if (branchResult.code !== 0 || !branch) {
    throw new IdeGitHubError(
      'Check out a local branch before opening a pull request.',
      'GITHUB_BRANCH_REQUIRED',
      409,
    );
  }

  const branchCheck = await git(input.workspace, ['check-ref-format', '--branch', branch]);
  if (branchCheck.code !== 0 || branch.startsWith('-')) {
    throw new IdeGitHubError(
      'The current branch name is not valid for push.',
      'GITHUB_INVALID_BRANCH',
      400,
    );
  }

  let repositoryDetails;
  try {
    repositoryDetails = await octokit.rest.repos.get({
      owner: repository.owner,
      repo: repository.name,
    });
  } catch (error) {
    throw githubRequestError(error, 'Could not access the GitHub repository.', input.token);
  }

  const base = requestedBase || repositoryDetails.data.default_branch;
  const baseCheck = await git(input.workspace, ['check-ref-format', '--branch', base]);
  if (baseCheck.code !== 0 || base.startsWith('-')) {
    throw new IdeGitHubError(
      'The pull request base branch is invalid.',
      'GITHUB_INVALID_BASE',
      400,
    );
  }
  if (base === branch) {
    throw new IdeGitHubError(
      `The current branch is already the base branch (${base}).`,
      'GITHUB_SAME_HEAD_AND_BASE',
      409,
    );
  }

  const push = await git(
    input.workspace,
    ['push', '--porcelain', '-u', 'origin', branch],
    GIT_NETWORK_TIMEOUT_MS,
  );
  if (push.timedOut) {
    throw new IdeGitHubError('Git push timed out.', 'GIT_TIMEOUT', 504);
  }
  if (push.code !== 0) {
    throw new IdeGitHubError(
      gitFailureMessage(push, 'Git push failed.', input.token),
      'GITHUB_PUSH_FAILED',
      409,
    );
  }

  try {
    const result = await octokit.rest.pulls.create({
      owner: repository.owner,
      repo: repository.name,
      title,
      head: branch,
      base,
      body,
    });
    return { number: result.data.number, url: result.data.html_url };
  } catch (error) {
    throw githubRequestError(error, 'Could not create the pull request.', input.token);
  }
}

export async function createIdeGitHubIssue(input: {
  workspace: string;
  token?: string;
  title: string;
  body?: string;
}): Promise<{ number: number; url: string }> {
  const title = requiredText(input.title, 'Issue title', MAX_TITLE_CHARS);
  const body = optionalText(input.body, 'Issue body', MAX_BODY_CHARS);
  const { repository, octokit } = await requireRepositoryAndToken(input.workspace, input.token);
  try {
    const result = await octokit.rest.issues.create({
      owner: repository.owner,
      repo: repository.name,
      title,
      body,
    });
    return { number: result.data.number, url: result.data.html_url };
  } catch (error) {
    throw githubRequestError(error, 'Could not create the issue.', input.token);
  }
}
