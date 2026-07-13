import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-worktree-integrity-'));
  const data = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const movedWorkspace = path.join(root, 'moved-workspace');
  const remote = path.join(root, 'origin.git');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_SECRET_KEY = '42'.repeat(32);

  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(movedWorkspace, { recursive: true });
  await fs.writeFile(path.join(workspace, '.gitignore'), '.worktrees/\n');
  await fs.writeFile(path.join(workspace, 'README.md'), '# Worktree integrity fixture\n');
  git(workspace, 'init');
  git(workspace, 'branch', '-M', 'main');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'config', 'user.email', 'worktree-integrity@example.invalid');
  git(workspace, 'config', 'user.name', 'Worktree Integrity Verifier');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'baseline');
  await fs.mkdir(remote, { recursive: true });
  git(remote, 'init', '--bare');
  git(workspace, 'remote', 'add', 'origin', remote);
  git(workspace, 'push', '--quiet', '-u', 'origin', 'main');

  const database = await import('../lib/db');
  const workspaceModule = await import('../lib/workspace');
  const integrity = await import('../lib/worktree-integrity');
  const registryPath = path.join(data, 'worktree-resources.json');

  try {
    const clean = await workspaceModule.ensureWorktree(workspace, 'orphan-clean', 'main');
    const dirty = await workspaceModule.ensureWorktree(workspace, 'orphan-dirty', 'main');
    const unpushed = await workspaceModule.ensureWorktree(workspace, 'orphan-unpushed', 'main');
    const activeAgent = await workspaceModule.ensureWorktree(workspace, 'active-agent', 'main');
    const activeTask = await workspaceModule.ensureWorktree(
      workspace,
      'active-task-agent',
      'main',
      { taskId: 'active-worktree-task' },
    );

    await fs.writeFile(path.join(dirty.worktreePath, 'uncommitted.txt'), 'user bytes that must survive\n');
    await fs.writeFile(path.join(unpushed.worktreePath, 'unpushed.txt'), 'committed but not pushed\n');
    git(unpushed.worktreePath, 'add', 'unpushed.txt');
    git(unpushed.worktreePath, 'commit', '-m', 'local-only work');

    const now = new Date().toISOString();
    database.getDb().prepare(`
      INSERT INTO tasks (
        id, kind, status, title, description, originType, agentId,
        workspaceRoots, plan, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'active-worktree-task',
      'code',
      'running',
      'Keep task worktree alive',
      '',
      'manual',
      'active-task-agent',
      '[]',
      '[]',
      '{}',
      now,
      now,
    );

    // Re-registering live ownership must cancel an earlier cleanup tombstone.
    await integrity.requestWorktreeResourceDeletion(workspace, 'active-agent', 'stale request');
    await integrity.registerWorktreeResource({
      baseWorkspace: workspace,
      agentId: 'active-agent',
      active: true,
    });

    // Backdate every record so preservation is proven by ownership/dirty data,
    // not by the short creator-race grace period.
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      resources: Array<{ createdAt: string; updatedAt: string }>;
    };
    for (const record of registry.resources) {
      record.createdAt = old;
      record.updatedAt = old;
    }
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const agents = [{
      id: 'active-agent',
      workspace: { path: workspace, useWorktree: true },
    }, {
      // An agent ID collision in another workspace must not own orphan-clean.
      id: 'orphan-clean',
      workspace: { path: movedWorkspace, useWorktree: true },
    }];
    const first = await integrity.reconcileWorktreeResources({ agents });
    assert.equal(first.tracked, 5);
    assert.equal(first.discovered, 0);
    assert.equal(first.removed, 1, 'a clean, remotely reachable orphan must be removed');
    assert.equal(first.attention, 2, 'dirty and unpushed worktrees must require attention');
    assert.deepEqual(first.errors, []);
    assert.equal(await pathExists(clean.worktreePath), false);
    assert.equal(await pathExists(dirty.worktreePath), true, 'dirty worktree bytes must be preserved');
    assert.equal(await pathExists(unpushed.worktreePath), true, 'unpushed commits must be preserved');
    assert.equal(await pathExists(activeAgent.worktreePath), true, 'configured agent worktree must be preserved');
    assert.equal(await pathExists(activeTask.worktreePath), true, 'active task worktree must be preserved');

    const afterFirst = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      resources: Array<{ agentId: string; state: string; attention?: string; deleteRequestedAt?: string }>;
    };
    assert.equal(afterFirst.resources.length, 4);
    const byAgent = new Map(afterFirst.resources.map((record) => [record.agentId, record]));
    assert.match(byAgent.get('orphan-dirty')?.attention || '', /uncommitted/i);
    assert.match(byAgent.get('orphan-unpushed')?.attention || '', /unpushed|not present on a remote/i);
    assert.equal(byAgent.get('active-agent')?.state, 'active');
    assert.equal(byAgent.get('active-agent')?.deleteRequestedAt, undefined);
    assert.equal(byAgent.get('active-task-agent')?.state, 'active');

    const stableRegistry = await fs.readFile(registryPath, 'utf8');
    const stableRegistryMtime = (await fs.stat(registryPath)).mtimeMs;
    const second = await integrity.reconcileWorktreeResources({ agents });
    assert.equal(second.removed, 0);
    assert.equal(second.discovered, 0);
    assert.equal(second.attention, 2);
    assert.deepEqual(second.errors, []);
    assert.equal(
      await fs.readFile(registryPath, 'utf8'),
      stableRegistry,
      'a repeated sweep must not churn registry timestamps or ownership state',
    );
    assert.equal(
      (await fs.stat(registryPath)).mtimeMs,
      stableRegistryMtime,
      'an idempotent sweep must not rewrite an unchanged registry',
    );

    await assert.rejects(
      integrity.registerWorktreeResource({ baseWorkspace: workspace, agentId: 'NUL' }),
      /invalid worktree resource agent id/i,
      'registry validation must match Windows-safe worktree path validation',
    );

    const recreated = await workspaceModule.ensureWorktree(workspace, 'orphan-clean', 'main');
    assert.equal(recreated.created, true, 'cleanup must leave its existing branch reusable');
    assert.equal(await pathExists(recreated.worktreePath), true);

    const registryLock = `${registryPath}.lock`;
    await fs.writeFile(registryLock, JSON.stringify({
      pid: 2_147_483_647,
      token: 'crashed-owner',
      createdAt: old,
    }));
    await integrity.registerWorktreeResource({
      baseWorkspace: workspace,
      agentId: 'active-agent',
      active: true,
    });
    assert.equal(await pathExists(registryLock), false, 'a dead process must not orphan the registry lock');

    console.log('Worktree ownership integrity verification passed');
  } finally {
    database.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Worktree ownership integrity verification failed', error);
  process.exit(1);
});
