// Git actions issued straight from Grok Chat (/git …) and agent tools —
// status, branch checkout, commit, and GitHub pull requests against a
// workspace repository.

import { shellExec } from './workspace';
import { githubCreatePr } from './integrations';

const GIT_TIMEOUT_MS = 30_000;

/** Branch names limited to safe git ref characters — no shell metacharacters. */
export function safeBranch(name: string): string {
  const clean = String(name || '').trim();
  if (!clean || !/^[A-Za-z0-9._/-]+$/.test(clean) || clean.includes('..')) {
    throw new Error(`Invalid branch name "${clean}" — letters, digits, ".", "_", "/", "-" only`);
  }
  return clean;
}

async function git(cwd: string, args: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return shellExec(`git ${args}`, cwd, GIT_TIMEOUT_MS);
}

async function ensureRepo(cwd: string): Promise<void> {
  const r = await git(cwd, 'rev-parse --is-inside-work-tree');
  if (r.code !== 0) throw new Error(`Not a git repository: ${cwd}`);
}

export async function gitStatus(cwd: string): Promise<string> {
  await ensureRepo(cwd);
  const branch = (await git(cwd, 'branch --show-current')).stdout.trim() || '(detached)';
  const status = await git(cwd, 'status --porcelain=v1');
  const changes = status.stdout.trim();
  const log = (await git(cwd, 'log --oneline -3')).stdout.trim();
  return [
    `**Branch:** \`${branch}\``,
    changes ? `**Changes:**\n\`\`\`\n${changes.slice(0, 2000)}\n\`\`\`` : '**Working tree clean.**',
    log ? `**Recent commits:**\n\`\`\`\n${log}\n\`\`\`` : '',
  ].filter(Boolean).join('\n\n');
}

export async function gitCheckout(cwd: string, branchName: string): Promise<string> {
  await ensureRepo(cwd);
  const branch = safeBranch(branchName);
  // Existing branch → switch; otherwise create it from HEAD.
  const existing = await git(cwd, `rev-parse --verify --quiet refs/heads/${branch}`);
  const r = existing.code === 0
    ? await git(cwd, `checkout ${branch}`)
    : await git(cwd, `checkout -b ${branch}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `checkout failed (${r.code})`);
  return existing.code === 0
    ? `Switched to branch \`${branch}\`.`
    : `Created and switched to new branch \`${branch}\`.`;
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
  await ensureRepo(cwd);
  const msg = String(message || '').trim().replace(/"/g, "'").slice(0, 200);
  if (!msg) throw new Error('Commit message required — /git commit <message>');
  await git(cwd, 'add -A');
  const r = await git(cwd, `commit -m "${msg}"`);
  if (r.code !== 0) {
    const out = (r.stdout + r.stderr).trim();
    if (/nothing to commit/i.test(out)) return 'Nothing to commit — working tree clean.';
    throw new Error(out.slice(0, 400) || `commit failed (${r.code})`);
  }
  return `Committed:\n\`\`\`\n${r.stdout.trim().slice(0, 500)}\n\`\`\``;
}

/** Push the current branch and open a GitHub PR via the configured token. */
export async function gitCreatePr(cwd: string, title: string, body?: string): Promise<string> {
  await ensureRepo(cwd);
  if (!String(title || '').trim()) throw new Error('PR title required — /git pr <title>');

  const branch = (await git(cwd, 'branch --show-current')).stdout.trim();
  if (!branch) throw new Error('Detached HEAD — checkout a branch first (/git checkout <name>)');

  const remoteUrl = (await git(cwd, 'remote get-url origin')).stdout.trim();
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.\s]+)(?:\.git)?/);
  if (!m) throw new Error(`Origin is not a GitHub remote (${remoteUrl || 'no origin remote'})`);
  const [, owner, repo] = m;

  const push = await git(cwd, `push -u origin ${safeBranch(branch)}`);
  if (push.code !== 0) throw new Error(`Push failed: ${(push.stderr || push.stdout).trim().slice(0, 400)}`);

  // Base = the remote's default branch (falls back to main).
  const headRef = (await git(cwd, 'symbolic-ref refs/remotes/origin/HEAD --short')).stdout.trim();
  const base = headRef.replace(/^origin\//, '') || 'main';
  if (base === branch) throw new Error(`You are on the default branch (${base}) — checkout a feature branch first`);

  const pr = await githubCreatePr(owner, repo, title.trim().slice(0, 200), branch, base, body);
  return `Pull request [#${pr.number}](${pr.url}) opened: \`${branch}\` → \`${base}\`.`;
}
