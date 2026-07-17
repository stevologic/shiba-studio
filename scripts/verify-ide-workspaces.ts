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

async function initializeRepository(repository: string): Promise<void> {
  await fs.mkdir(repository, { recursive: true });
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  git(repository, 'init');
  git(repository, 'branch', '-M', 'main');
  git(repository, 'config', 'core.autocrlf', 'false');
  git(repository, 'config', 'user.email', 'ide-workspaces@example.invalid');
  git(repository, 'config', 'user.name', 'IDE Workspace Verifier');
  git(repository, 'config', 'commit.gpgSign', 'false');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'fixture');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-ide-workspaces-'));
  const dataDirectory = path.join(root, 'data');
  const defaultRepository = path.join(root, 'default-repository');
  const defaultLinkedWorktree = path.join(root, 'linked-default-feature');
  const projectRepository = path.join(root, 'project-repository');
  const projectLinkedWorktree = path.join(root, 'linked-project-feature');
  const agentRepository = path.join(root, 'agent-repository');
  const agentLinkedWorktree = path.join(
    agentRepository,
    '.worktrees',
    'agent-with-separate-repository',
  );
  const plainProject = path.join(root, 'plain-project');
  const missingProject = path.join(root, 'missing-project');
  let checks = 0;
  const check = (condition: unknown, message: string): void => {
    assert.ok(condition, message);
    checks += 1;
  };

  process.env.SHIBA_DATA_DIR = dataDirectory;
  process.env.SHIBA_PROJECT_ROOT = root;

  try {
    await Promise.all([
      initializeRepository(defaultRepository),
      initializeRepository(projectRepository),
      initializeRepository(agentRepository),
      initializeRepository(plainProject),
      fs.mkdir(dataDirectory, { recursive: true }),
    ]);
    git(defaultRepository, 'branch', 'feature/default-picker');
    git(
      defaultRepository,
      'worktree',
      'add',
      defaultLinkedWorktree,
      'feature/default-picker',
    );
    git(projectRepository, 'branch', 'feature/project-picker');
    git(
      projectRepository,
      'worktree',
      'add',
      projectLinkedWorktree,
      'feature/project-picker',
    );
    git(agentRepository, 'branch', 'feature/agent-picker');
    await fs.mkdir(path.dirname(agentLinkedWorktree), { recursive: true });
    git(
      agentRepository,
      'worktree',
      'add',
      agentLinkedWorktree,
      'feature/agent-picker',
    );

    const { discoverIdeWorkspaceOptions } = await import('../lib/ide-workspace-options');
    const projects = [
      { id: 'inherits-default', name: 'Default project', workspacePath: '' },
      {
        id: 'default-alias',
        name: 'Default alias',
        workspacePath: path.join(defaultRepository, '.'),
      },
      { id: 'missing', name: 'Missing project', workspacePath: missingProject },
      { id: 'plain', name: 'Plain project', workspacePath: plainProject },
      { id: 'secondary', name: 'Secondary project', workspacePath: projectRepository },
      {
        id: 'secondary-alias',
        name: 'Secondary alias',
        workspacePath: path.join(projectRepository, '.'),
      },
    ];
    const agents = [{
      id: 'agent-with-separate-repository',
      name: 'Orbit Agent',
      workspace: {
        path: agentRepository,
        useWorktree: true,
      },
    }];

    const result = await discoverIdeWorkspaceOptions({
      configuredDefaultWorkspace: path.join(defaultRepository, '.'),
      projects,
      agents,
      root,
    });
    const defaultRealPath = await fs.realpath(defaultRepository);
    const projectRealPath = await fs.realpath(projectRepository);
    const defaultWorktreeRealPath = await fs.realpath(defaultLinkedWorktree);
    const projectWorktreeRealPath = await fs.realpath(projectLinkedWorktree);
    const agentRepositoryRealPath = await fs.realpath(agentRepository);
    const agentWorktreeRealPath = await fs.realpath(agentLinkedWorktree);

    check(result.ok && result.projectCount === projects.length, 'saved project count is retained');
    check(
      result.options[0].kind === 'default'
        && result.options[0].isDefault === true
        && result.defaultWorkspace === defaultRealPath,
      'canonical default workspace is always first',
    );
    check(
      result.options.some((option) => (
        option.kind === 'project'
        && option.projectId === 'missing'
        && option.path === path.resolve(missingProject)
        && option.available === false
        && option.detail?.includes('does not exist')
      )),
      'missing project workspace is retained as an unavailable option',
    );
    check(
      result.options.some((option) => (
        option.kind === 'project'
        && option.path === projectRealPath
        && option.available
      )),
      'available explicit project workspace is selectable',
    );
    check(
      result.options.some((option) => (
        option.kind === 'worktree'
        && option.path === defaultWorktreeRealPath
        && option.branch === 'feature/default-picker'
      )),
      'linked worktree outside .worktrees is discovered from the default workspace',
    );
    check(
      result.options.some((option) => (
        option.kind === 'worktree'
        && option.path === projectWorktreeRealPath
        && option.branch === 'feature/project-picker'
        && option.basePath === projectRealPath
      )),
      'worktrees are discovered for each unique project workspace',
    );
    check(
      result.options.some((option) => (
        option.kind === 'worktree'
        && option.path === agentWorktreeRealPath
        && option.branch === 'feature/agent-picker'
        && option.basePath === agentRepositoryRealPath
        && option.agentName === 'Orbit Agent'
      )),
      'worktrees outside saved projects use their agent name',
    );
    const optionPathKeys = result.options.map((option) => (
      process.platform === 'win32' ? option.path.toLowerCase() : option.path
    ));
    check(
      new Set(optionPathKeys).size === optionPathKeys.length,
      'canonical paths are globally deduplicated',
    );
    check(
      result.options.filter((option) => option.path === defaultRealPath).length === 1
        && result.options.filter((option) => option.path === projectRealPath).length === 1,
      'Git base checkouts and project aliases are not repeated as worktrees',
    );
    const repeated = await discoverIdeWorkspaceOptions({
      configuredDefaultWorkspace: defaultRepository,
      projects,
      agents,
      root,
    });
    assert.deepEqual(repeated, result);
    checks += 1;

    const fallbackRoot = await fs.realpath(plainProject);
    const noProjects = await discoverIdeWorkspaceOptions({
      configuredDefaultWorkspace: '',
      projects: [],
      agents: [],
      root: plainProject,
    });
    check(
      noProjects.projectCount === 0
        && noProjects.defaultWorkspace === fallbackRoot
        && noProjects.options.length === 1
        && noProjects.options[0].kind === 'default',
      'default workspace remains available when no projects exist',
    );

    const unavailableDefault = await discoverIdeWorkspaceOptions({
      configuredDefaultWorkspace: path.join(root, 'missing-default'),
      projects: [],
      agents: [],
      root,
    });
    check(
      unavailableDefault.options.length === 1
        && unavailableDefault.options[0].kind === 'default'
        && unavailableDefault.options[0].available === false,
      'an unavailable configured default is still returned first',
    );

    const gitUnavailable = await discoverIdeWorkspaceOptions({
      configuredDefaultWorkspace: defaultRepository,
      projects: [],
      agents: [],
      root,
      gitCommand: `missing-git-${Date.now()}`,
    });
    check(
      gitUnavailable.options.length === 1 && gitUnavailable.options[0].kind === 'default',
      'missing Git does not prevent opening the workspace',
    );

    const route = await import('../app/api/ide/workspaces/route');
    const response = await route.GET();
    const payload = await response.json() as {
      ok?: boolean;
      defaultWorkspace?: string;
      options?: Array<{ kind?: string }>;
      projectCount?: number;
    };
    check(
      response.status === 200
        && response.headers.get('cache-control')?.includes('no-store')
        && payload.ok === true
        && payload.defaultWorkspace === await fs.realpath(root)
        && payload.options?.[0]?.kind === 'default'
        && payload.projectCount === 0,
      'GET route returns a fresh typed default fallback',
    );

    console.log(`${checks} IDE workspace option checks passed`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('IDE workspace option verification failed', error);
  process.exit(1);
});
