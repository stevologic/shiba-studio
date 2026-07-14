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
  await fs.writeFile(path.join(workspace, '.gitignore'), '.worktrees/\nlocal-secret.*\n');
  await fs.writeFile(path.join(workspace, 'README.md'), '# Worktree integrity fixture\n');
  git(workspace, 'init');
  git(workspace, 'branch', '-M', 'main');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'config', 'user.email', 'worktree-integrity@example.invalid');
  git(workspace, 'config', 'user.name', 'Worktree Integrity Verifier');
  git(workspace, 'config', 'commit.gpgSign', 'false');
  git(workspace, 'config', 'tag.gpgSign', 'false');
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
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(`${registryPath}.lock`, `${JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000001',
      createdAt: new Date().toISOString(),
    })}\n`);
    const clean = await workspaceModule.ensureWorktree(workspace, 'orphan-clean', 'main');
    assert.equal(
      (await fs.lstat(`${registryPath}.lock`)).isDirectory(),
      true,
      'a dead legacy registry lock file migrates to the generation lock directory',
    );
    const dirty = await workspaceModule.ensureWorktree(workspace, 'orphan-dirty', 'main');
    const unpushed = await workspaceModule.ensureWorktree(workspace, 'orphan-unpushed', 'main');
    const activeAgent = await workspaceModule.ensureWorktree(workspace, 'active-agent', 'main');
    const activeTask = await workspaceModule.ensureWorktree(
      workspace,
      'active-task-agent',
      'main',
      { taskId: 'active-worktree-task' },
    );
    const exactChat = await workspaceModule.ensureWorktree(workspace, 'exact-chat', 'main');
    const nestedChat = await workspaceModule.ensureWorktree(workspace, 'nested-chat', 'main');
    const projectChat = await workspaceModule.ensureWorktree(workspace, 'project-chat', 'main');
    const nestedChatDir = path.join(nestedChat.worktreePath, 'packages', 'app');
    await fs.mkdir(nestedChatDir, { recursive: true });

    await fs.writeFile(path.join(dirty.worktreePath, 'uncommitted.txt'), 'user bytes that must survive\n');
    await fs.writeFile(path.join(unpushed.worktreePath, 'unpushed.txt'), 'committed but not pushed\n');
    git(unpushed.worktreePath, 'add', 'unpushed.txt');
    git(unpushed.worktreePath, 'commit', '-m', 'local-only work');

    const unregistered = path.join(workspace, '.worktrees', 'unregistered-user-tree');
    await fs.mkdir(unregistered, { recursive: true });
    await fs.writeFile(path.join(unregistered, 'keep.txt'), 'not in Shiba registry\n');

    const now = new Date().toISOString();
    const insertTask = database.getDb().prepare(`
      INSERT INTO tasks (
        id, kind, status, title, description, originType, agentId,
        workspaceRoots, plan, metadata, createdAt, updatedAt
      ) VALUES (?, 'code', 'running', ?, '', 'manual', ?, ?, '[]', '{}', ?, ?)
    `);
    insertTask.run(
      'active-worktree-task',
      'Keep exact task worktree alive',
      'active-task-agent',
      JSON.stringify([{ id: 'task-root', path: activeTask.worktreePath, label: 'task', readOnly: false }]),
      now,
      now,
    );
    insertTask.run(
      'same-agent-other-repo-task',
      'Do not retain a different repository by agent id alone',
      'orphan-clean',
      JSON.stringify([{ id: 'other-root', path: movedWorkspace, label: 'other', readOnly: false }]),
      now,
      now,
    );

    // Re-registering durable ownership must cancel an earlier cleanup tombstone.
    await integrity.requestWorktreeResourceDeletion(workspace, 'active-agent', 'stale request');
    await integrity.registerWorktreeResource({
      baseWorkspace: workspace,
      agentId: 'active-agent',
      active: true,
    });

    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const mutateRegistry = async (
      mutate: (resources: Array<Record<string, unknown>>) => void,
    ) => {
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
        resources: Array<Record<string, unknown>>;
      };
      mutate(registry.resources);
      await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    };
    await mutateRegistry((resources) => {
      for (const record of resources) {
        record.createdAt = old;
        record.updatedAt = old;
      }
    });

    // A newly registered `creating` generation may not have a visible folder
    // yet; a concurrent sweep must retain it rather than losing ownership.
    await integrity.registerWorktreeResource({ baseWorkspace: workspace, agentId: 'creating-race' });
    await integrity.registerWorktreeResource({
      baseWorkspace: workspace,
      agentId: 'task-handoff-race',
      taskId: 'not-durable-yet',
    });
    await integrity.requestWorktreeResourceDeletion(
      workspace,
      'task-handoff-race',
      'concurrent agent deletion',
    );

    const agents = [{
      id: 'active-agent',
      workspace: { path: workspace, useWorktree: true },
    }, {
      // Equal agent id in a different repository is not an owner.
      id: 'orphan-clean',
      workspace: { path: movedWorkspace, useWorktree: true },
    }];
    const sessions = [
      { workspaceDir: exactChat.worktreePath, archived: true },
      { workspaceDir: nestedChatDir },
      { projectId: 'project-owner' },
      // A base-repository chat must not retain every child worktree.
      { workspaceDir: workspace },
    ];
    const projects = [{ id: 'project-owner', workspacePath: projectChat.worktreePath }];

    const first = await integrity.reconcileWorktreeResources({ agents, sessions, projects });
    assert.equal(first.tracked, 10);
    assert.equal(first.discovered, 0);
    assert.equal(first.removed, 0, 'automatic cleanup must publish a tombstone before deleting');
    assert.equal(
      first.pending,
      6,
      'automatic orphans, active task ownership, and both creation handoffs are pending',
    );
    assert.equal(first.attention, 0);
    assert.deepEqual(first.errors, []);
    assert.equal(await pathExists(clean.worktreePath), true);
    assert.equal(await pathExists(activeAgent.worktreePath), true);
    assert.equal(await pathExists(activeTask.worktreePath), true);
    assert.equal(await pathExists(exactChat.worktreePath), true, 'archived direct chat owns its worktree');
    assert.equal(await pathExists(nestedChat.worktreePath), true, 'nested chat workspace owns its worktree');
    assert.equal(await pathExists(projectChat.worktreePath), true, 'project-derived chat workspace owns its worktree');
    assert.equal(await pathExists(unregistered), true, 'unregistered .worktrees content is outside deletion authority');

    let afterFirst = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      resources: Array<{ agentId: string; state: string; attention?: string; deleteRequestedAt?: string }>;
    };
    let byAgent = new Map(afterFirst.resources.map((record) => [record.agentId, record]));
    assert.equal(byAgent.get('active-agent')?.state, 'active');
    assert.equal(byAgent.get('active-agent')?.deleteRequestedAt, undefined);
    assert.equal(byAgent.get('active-task-agent')?.state, 'delete_requested', 'task-only ownership keeps cleanup intent');
    assert.equal(byAgent.get('creating-race')?.state, 'creating');
    assert.equal(byAgent.get('task-handoff-race')?.state, 'delete_requested', 'fresh task handoff survives cleanup request');

    if (process.platform === 'win32') {
      const count = afterFirst.resources.length;
      await integrity.registerWorktreeResource({
        baseWorkspace: workspace,
        agentId: 'ACTIVE-AGENT',
        active: true,
      });
      afterFirst = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
      assert.equal(afterFirst.resources.length, count, 'case aliases cannot register the same NTFS path twice');
    }

    await mutateRegistry((resources) => {
      for (const record of resources) {
        if (['orphan-clean', 'orphan-dirty', 'orphan-unpushed'].includes(String(record.agentId))) {
          record.deleteRequestedAt = old;
        }
      }
    });
    const second = await integrity.reconcileWorktreeResources({ agents, sessions, projects });
    assert.equal(second.removed, 1, 'expired clean orphan is removed');
    assert.equal(second.pending, 3, 'active task ownership and fresh creation generations remain pending');
    assert.equal(second.attention, 2, 'dirty and unpushed worktrees require attention');
    assert.deepEqual(second.errors, []);
    assert.equal(await pathExists(clean.worktreePath), false);
    assert.equal(await pathExists(dirty.worktreePath), true, 'dirty worktree bytes must be preserved');
    assert.equal(await pathExists(unpushed.worktreePath), true, 'unpushed commits must be preserved');
    assert.equal(await pathExists(unregistered), true);

    const stableRegistry = await fs.readFile(registryPath, 'utf8');
    const stableRegistryMtime = (await fs.stat(registryPath)).mtimeMs;
    const stable = await integrity.reconcileWorktreeResources({ agents, sessions, projects });
    assert.equal(stable.removed, 0);
    assert.equal(stable.attention, 2);
    assert.equal(await fs.readFile(registryPath, 'utf8'), stableRegistry, 'idempotent sweep does not churn registry');
    assert.equal((await fs.stat(registryPath)).mtimeMs, stableRegistryMtime, 'idempotent sweep does not rewrite');

    const ignored = await workspaceModule.ensureWorktree(workspace, 'orphan-ignored', 'main');
    await fs.writeFile(path.join(ignored.worktreePath, 'local-secret.env'), 'must never be deleted\n');
    await integrity.requestWorktreeResourceDeletion(workspace, 'orphan-ignored', 'test ignored-file safety');
    await integrity.reconcileWorktreeResources({ agents, sessions, projects });
    assert.equal(await pathExists(ignored.worktreePath), true, 'ignored worktree files must be preserved');
    const ignoredRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.match(
      ignoredRegistry.resources.find((record) => record.agentId === 'orphan-ignored')?.attention || '',
      /ignored files/i,
      'ignored bytes are surfaced instead of being removed by Git',
    );

    database.getDb().prepare('DELETE FROM tasks').run();
    const detached = await integrity.reconcileWorktreeResources({ agents: [], sessions: [], projects: [] });
    assert.equal(detached.pending, 7, 'durable owners detach in phase one while creation leases remain');
    await mutateRegistry((resources) => {
      for (const record of resources) {
        if (['active-agent', 'active-task-agent', 'exact-chat', 'nested-chat', 'project-chat'].includes(String(record.agentId))) {
          record.deleteRequestedAt = old;
        }
      }
    });
    const detachedExpired = await integrity.reconcileWorktreeResources({ agents: [], sessions: [], projects: [] });
    assert.equal(detachedExpired.removed, 5, 'last agent/chat/task owner removal reclaims clean worktrees');
    assert.equal(await pathExists(activeAgent.worktreePath), false);
    assert.equal(await pathExists(activeTask.worktreePath), false);
    assert.equal(await pathExists(exactChat.worktreePath), false);
    assert.equal(await pathExists(nestedChat.worktreePath), false);
    assert.equal(await pathExists(projectChat.worktreePath), false);
    assert.equal(await pathExists(unregistered), true, 'unknown user directory remains untouched');

    // Older Shiba builds could leave behind valid Git worktrees without a
    // registry record. Adopt only worktrees that still belong to this
    // repository and use Shiba's exact agent-<id> branch convention. They
    // must then pass through the same grace period and byte-safety checks as
    // worktrees created by the current registry-aware path.
    const legacyCleanId = 'legacy-clean-adoption';
    const legacyDirtyId = 'legacy-dirty-adoption';
    const mismatchedId = 'legacy-mismatched-branch';
    const legacyCleanPath = path.join(workspace, '.worktrees', legacyCleanId);
    const legacyDirtyPath = path.join(workspace, '.worktrees', legacyDirtyId);
    const mismatchedPath = path.join(workspace, '.worktrees', mismatchedId);
    git(workspace, 'worktree', 'add', '-b', `agent-${legacyCleanId}`, legacyCleanPath, 'main');
    git(workspace, 'push', '--quiet', '-u', 'origin', `agent-${legacyCleanId}`);
    git(workspace, 'worktree', 'add', '-b', `agent-${legacyDirtyId}`, legacyDirtyPath, 'main');
    await fs.writeFile(path.join(legacyDirtyPath, 'untracked-user-bytes.txt'), 'must survive cleanup\n');
    git(workspace, 'worktree', 'add', '-b', 'manual-legacy-mismatch', mismatchedPath, 'main');

    const beforeLegacyAdoption = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      beforeLegacyAdoption.resources.some((record) => [legacyCleanId, legacyDirtyId, mismatchedId].includes(record.agentId)),
      false,
      'legacy fixtures begin outside Shiba registry authority',
    );

    const adoptedLegacy = await integrity.reconcileWorktreeResources({
      agents: [],
      sessions: [],
      projects: [],
      baseWorkspaces: [workspace],
    });
    assert.equal(adoptedLegacy.discovered, 2, 'only exact Shiba legacy worktrees are adopted');
    assert.equal(adoptedLegacy.removed, 0, 'adoption always publishes a tombstone before deletion');
    assert.equal(await pathExists(legacyCleanPath), true);
    assert.equal(await pathExists(legacyDirtyPath), true);
    assert.equal(await pathExists(mismatchedPath), true, 'a current-repository worktree on a manual branch is not adopted');
    assert.equal(await pathExists(unregistered), true, 'non-Git unregistered content is not adopted');

    let legacyRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      legacyRegistry.resources.find((record) => record.agentId === legacyCleanId)?.state,
      'delete_requested',
    );
    assert.equal(
      legacyRegistry.resources.find((record) => record.agentId === legacyDirtyId)?.state,
      'delete_requested',
    );
    assert.equal(
      legacyRegistry.resources.some((record) => record.agentId === mismatchedId),
      false,
      'branch-mismatched Git worktrees remain outside automatic deletion authority',
    );

    await mutateRegistry((resources) => {
      for (const record of resources) {
        if ([legacyCleanId, legacyDirtyId].includes(String(record.agentId))) {
          record.deleteRequestedAt = old;
        }
      }
    });
    const expiredLegacy = await integrity.reconcileWorktreeResources({
      agents: [],
      sessions: [],
      projects: [],
      baseWorkspaces: [workspace],
    });
    assert.equal(expiredLegacy.discovered, 0, 'adoption is idempotent once resources are registered');
    assert.equal(expiredLegacy.removed, 1, 'an expired clean and pushed legacy worktree is reclaimed');
    assert.equal(await pathExists(legacyCleanPath), false);
    assert.equal(await pathExists(legacyDirtyPath), true, 'untracked legacy bytes must be preserved');
    assert.equal(await pathExists(mismatchedPath), true, 'manual Git worktrees remain untouched');
    assert.equal(await pathExists(unregistered), true, 'non-Git unregistered content remains untouched');
    legacyRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      legacyRegistry.resources.some((record) => record.agentId === legacyCleanId),
      false,
      'successful legacy cleanup removes the adopted registry record',
    );
    assert.match(
      legacyRegistry.resources.find((record) => record.agentId === legacyDirtyId)?.attention || '',
      /uncommitted/i,
      'dirty adopted worktrees surface attention instead of deleting user bytes',
    );
    assert.equal(
      legacyRegistry.resources.some((record) => record.agentId === mismatchedId),
      false,
    );

    byAgent = new Map((JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst)
      .resources.map((record) => [record.agentId, record]));
    assert.match(byAgent.get('orphan-dirty')?.attention || '', /uncommitted/i);
    assert.match(byAgent.get('orphan-unpushed')?.attention || '', /unpushed|not present on a remote/i);
    assert.equal(byAgent.get('creating-race')?.state, 'creating');

    await assert.rejects(
      integrity.registerWorktreeResource({ baseWorkspace: workspace, agentId: 'NUL' }),
      /invalid worktree resource agent id/i,
      'registry validation must match Windows-safe worktree path validation',
    );

    // Exercise the real chat/project mutation hooks, not only injected
    // ownership snapshots. Project save happens before chat creation in the
    // UI, so phase-one cleanup must leave enough time for that attach.
    const projectsModule = await import('../lib/projects');
    const chatsModule = await import('../lib/chat-sessions');
    const projectHook = await workspaceModule.ensureWorktree(workspace, 'project-hook', 'main');
    await mutateRegistry((resources) => {
      const record = resources.find((candidate) => candidate.agentId === 'project-hook');
      if (record) record.createdAt = old;
    });
    const project = await projectsModule.createProject('Worktree hook project');
    await projectsModule.updateProject(project.id, { workspacePath: projectHook.worktreePath });
    assert.equal(await pathExists(projectHook.worktreePath), true, 'project save only tombstones in phase one');
    const projectSession = await chatsModule.createChatSession({ projectId: project.id, title: 'Project owner' });
    await integrity.reconcileWorktreeResources();
    assert.equal(await pathExists(projectHook.worktreePath), true, 'project-backed chat cancels cleanup');
    await chatsModule.deleteChatSession(projectSession.id);
    let hookRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      hookRegistry.resources.find((record) => record.agentId === 'project-hook')?.state,
      'delete_requested',
      'deleting the last project-backed chat queues cleanup',
    );
    await mutateRegistry((resources) => {
      const record = resources.find((candidate) => candidate.agentId === 'project-hook');
      if (record) record.deleteRequestedAt = old;
    });
    const projectCleanup = await integrity.reconcileWorktreeResources();
    assert.equal(await pathExists(projectHook.worktreePath), false);
    assert.equal(projectCleanup.projectMappingsDetached, 1, 'reclaiming a worktree clears its project pointer');
    assert.equal((await projectsModule.getProject(project.id))?.workspacePath, '');

    const directHook = await workspaceModule.ensureWorktree(workspace, 'direct-chat-hook', 'main');
    await mutateRegistry((resources) => {
      const record = resources.find((candidate) => candidate.agentId === 'direct-chat-hook');
      if (record) record.createdAt = old;
    });
    const directSession = await chatsModule.createChatSession({ title: 'Direct owner' });
    await chatsModule.updateChatSession(directSession.id, { workspaceDir: directHook.worktreePath });
    assert.equal(await pathExists(directHook.worktreePath), true, 'direct chat attach wins before cleanup');
    await chatsModule.updateChatSession(directSession.id, { title: 'Ordinary patch still works' });
    await chatsModule.updateChatSession(directSession.id, { workspaceDir: null });
    hookRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      hookRegistry.resources.find((record) => record.agentId === 'direct-chat-hook')?.state,
      'delete_requested',
      'unmapping the last direct chat queues cleanup',
    );
    await mutateRegistry((resources) => {
      const record = resources.find((candidate) => candidate.agentId === 'direct-chat-hook');
      if (record) record.deleteRequestedAt = old;
    });
    await integrity.reconcileWorktreeResources();
    assert.equal(await pathExists(directHook.worktreePath), false);
    await chatsModule.deleteChatSession(directSession.id);

    // Exercise the real agent API hook. Disabling a mapped agent publishes an
    // explicit deletion request and reclaims its clean worktree in the same
    // coordinated mutation, without waiting for the periodic sweep.
    const routeAgentId = 'agent-route-hook';
    const routeHook = await workspaceModule.ensureWorktree(workspace, routeAgentId, 'main');
    const { normalizeAgent } = await import('../lib/types');
    const persistence = await import('../lib/persistence');
    await persistence.saveAgents([normalizeAgent({
      id: routeAgentId,
      name: 'Worktree route hook',
      model: 'grok-4',
      workspace: { path: workspace, useWorktree: true },
      integrations: {},
      peers: [],
      createdAt: now,
      updatedAt: now,
    })]);
    const [{ NextRequest }, agentsRoute] = await Promise.all([
      import('next/server'),
      import('../app/api/agents/route'),
    ]);
    const disableResponse = await agentsRoute.POST(new NextRequest('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        agent: {
          id: routeAgentId,
          workspace: { path: workspace, useWorktree: false },
        },
      }),
    }));
    assert.equal(disableResponse.status, 200);
    assert.equal(
      await pathExists(routeHook.worktreePath),
      false,
      'disabling a mapped agent reclaims its clean worktree inline',
    );
    assert.equal(
      (await persistence.loadAgents()).find((agent) => agent.id === routeAgentId)?.workspace.useWorktree,
      false,
      'agent update commits the disabled worktree mapping',
    );
    const routeRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as typeof afterFirst;
    assert.equal(
      routeRegistry.resources.some((record) => record.agentId === routeAgentId),
      false,
      'successful agent cleanup removes its registry record',
    );
    assert.equal(
      Number((database.getDb().prepare('SELECT COUNT(*) AS count FROM data_integrity_requests').get() as { count: number }).count),
      0,
      'agent route completes its durable integrity request inline',
    );

    const recreated = await workspaceModule.ensureWorktree(workspace, 'orphan-clean', 'main');
    assert.equal(recreated.created, true, 'cleanup leaves its existing branch reusable');
    assert.equal(await pathExists(recreated.worktreePath), true);

    // Swapping the managed root for a symlink/junction must never redirect
    // cleanup outside the repository's real .worktrees directory.
    const trapBase = path.join(root, 'trap-base');
    const outside = path.join(root, 'outside-worktrees');
    await fs.mkdir(trapBase, { recursive: true });
    await fs.mkdir(path.join(outside, 'trap-agent'), { recursive: true });
    await fs.writeFile(path.join(outside, 'trap-agent', 'keep.txt'), 'outside bytes\n');
    await fs.symlink(outside, path.join(trapBase, '.worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    await integrity.registerWorktreeResource({ baseWorkspace: trapBase, agentId: 'trap-agent', active: true });
    await integrity.requestWorktreeResourceDeletion(trapBase, 'trap-agent', 'test unsafe root');
    const trapped = await integrity.reconcileWorktreeResources({ agents: [], sessions: [], projects: [] });
    assert.ok(trapped.attention >= 1);
    assert.equal(await pathExists(path.join(outside, 'trap-agent', 'keep.txt')), true, 'junction target is preserved');

    // Git canonicalizes worktree paths on some hosts (macOS commonly expands
    // /var to /private/var, and Windows can expand temp-directory junctions or
    // short names). A workspace alias is a safe ancestor, but the managed
    // .worktrees root and the candidate itself must still be real directories.
    const aliasedWorkspace = path.join(root, 'aliased-workspace');
    const workspaceAlias = path.join(root, 'workspace-ancestor-alias');
    const aliasedId = 'aliased-ancestor-adoption';
    const aliasedWorktree = path.join(aliasedWorkspace, '.worktrees', aliasedId);
    await fs.mkdir(path.join(aliasedWorkspace, '.worktrees'), { recursive: true });
    await fs.writeFile(path.join(aliasedWorkspace, '.gitignore'), '.worktrees/\n');
    await fs.writeFile(path.join(aliasedWorkspace, 'README.md'), '# Alias fixture\n');
    git(aliasedWorkspace, 'init');
    git(aliasedWorkspace, 'branch', '-M', 'main');
    git(aliasedWorkspace, 'config', 'user.email', 'worktree-integrity@example.invalid');
    git(aliasedWorkspace, 'config', 'user.name', 'Worktree Integrity Verifier');
    git(aliasedWorkspace, 'config', 'commit.gpgSign', 'false');
    git(aliasedWorkspace, 'add', '.');
    git(aliasedWorkspace, 'commit', '-m', 'alias baseline');
    git(aliasedWorkspace, 'worktree', 'add', '-b', `agent-${aliasedId}`, aliasedWorktree, 'main');
    await fs.symlink(
      aliasedWorkspace,
      workspaceAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const aliasAdoption = await integrity.reconcileWorktreeResources({
      agents: [],
      sessions: [],
      projects: [],
      baseWorkspaces: [workspaceAlias],
    });
    assert.equal(aliasAdoption.discovered, 1, 'ancestor aliases do not hide valid legacy Shiba worktrees');
    const aliasRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      resources: Array<{ agentId: string; baseWorkspace: string; worktreePath: string }>;
    };
    const adoptedAlias = aliasRegistry.resources.find((record) => record.agentId === aliasedId);
    assert.equal(adoptedAlias?.baseWorkspace, path.resolve(workspaceAlias));
    assert.equal(adoptedAlias?.worktreePath, path.resolve(workspaceAlias, '.worktrees', aliasedId));

    console.log('Worktree ownership integrity verification passed');
  } finally {
    await (await import('../lib/integrity-coordinator')).stopDataIntegritySchedule();
    database.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Worktree ownership integrity verification failed', error);
  process.exit(1);
});
