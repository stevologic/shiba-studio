import { expect, test, type Page, type Route } from '@playwright/test';

const WORKSPACE = 'C:\\mock\\shiba-studio';
const PROJECT_WORKSPACE = 'C:\\mock\\saved-project';
const WORKTREE_WORKSPACE = 'C:\\mock\\shiba-studio\\.worktrees\\feature-picker';
const FILE_PATH = 'src/app.ts';
const INITIAL_SOURCE = "export const greeting = 'hello';\n";
const EDITED_SOURCE = "export const greeting = 'edited';\n";
const DEFAULT_WORKSPACE_ID = 'default:shiba-studio';
const PROJECT_WORKSPACE_ID = 'project:saved-project';
const WORKTREE_WORKSPACE_ID = 'worktree:feature-picker';

type GitPhase = 'working' | 'staged' | 'clean';

function gitSnapshot(phase: GitPhase) {
  const status = phase === 'clean'
    ? []
    : [{
      path: FILE_PATH,
      indexStatus: phase === 'staged' ? 'M' : '.',
      workingTreeStatus: phase === 'working' ? 'M' : '.',
      staged: phase === 'staged',
      unstaged: phase === 'working',
      untracked: false,
      conflicted: false,
      renamed: false,
    }];

  return {
    repoRoot: WORKSPACE,
    workspace: WORKSPACE,
    head: {
      oid: '0123456789abcdef0123456789abcdef01234567',
      branch: 'development',
      detached: false,
      unborn: false,
    },
    upstream: 'origin/development',
    ahead: phase === 'clean' ? 1 : 0,
    behind: 0,
    clean: phase === 'clean',
    status,
    branches: [{
      name: 'development',
      current: true,
      oid: '0123456789abcdef0123456789abcdef01234567',
      upstream: 'origin/development',
      ahead: phase === 'clean' ? 1 : 0,
      behind: 0,
      gone: false,
      lastCommitAt: '2026-07-17T08:00:00.000Z',
      subject: phase === 'clean' ? 'test: save from Code' : 'feat: start Code IDE',
    }],
    commits: [{
      oid: '0123456789abcdef0123456789abcdef01234567',
      shortOid: '0123456',
      authorName: 'Shiba Developer',
      authorEmail: 'shiba@example.test',
      authoredAt: '2026-07-17T08:00:00.000Z',
      subject: phase === 'clean' ? 'test: save from Code' : 'feat: start Code IDE',
    }],
    remotes: [{
      name: 'origin',
      fetchUrls: ['https://github.com/shiba-labs/shiba-studio.git'],
      pushUrls: ['https://github.com/shiba-labs/shiba-studio.git'],
    }],
    github: {
      remote: 'origin',
      host: 'github.com',
      owner: 'shiba-labs',
      repo: 'shiba-studio',
      slug: 'shiba-labs/shiba-studio',
      webUrl: 'https://github.com/shiba-labs/shiba-studio',
    },
  };
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

async function mockWorkspaceOptions(page: Page) {
  await page.route('**/api/ide/workspaces', async (route) => {
    await fulfillJson(route, {
      ok: true,
      defaultWorkspace: WORKSPACE,
      projectCount: 1,
      options: [
        {
          id: DEFAULT_WORKSPACE_ID,
          kind: 'default',
          label: 'Default workspace',
          path: WORKSPACE,
          available: true,
          isDefault: true,
        },
        {
          id: PROJECT_WORKSPACE_ID,
          kind: 'project',
          label: 'Saved project',
          path: PROJECT_WORKSPACE,
          available: true,
          projectId: 'saved-project',
          projectName: 'Saved project',
        },
        {
          id: WORKTREE_WORKSPACE_ID,
          kind: 'worktree',
          label: 'feature-picker',
          path: WORKTREE_WORKSPACE,
          available: true,
          basePath: WORKSPACE,
          branch: 'feature/workspace-picker',
        },
      ],
    });
  });
}

test('Code edits and saves a file, commits it, and shows GitHub activity', async ({ page }) => {
  const saves: Array<Record<string, unknown>> = [];
  const gitActions: Array<Record<string, unknown>> = [];
  let gitPhase: GitPhase = 'working';

  await mockWorkspaceOptions(page);

  await page.route('**/api/ide/files**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'POST') {
      const body = await request.postDataJSON() as Record<string, unknown>;
      if (body.action === 'save') {
        saves.push(body);
        await fulfillJson(route, {
          ok: true,
          workspace: WORKSPACE,
          path: FILE_PATH,
          content: body.content,
          size: String(body.content || '').length,
          mtimeMs: 1_752_739_200_000,
          version: 'version-2',
        });
        return;
      }
    }

    if (url.searchParams.get('action') === 'read') {
      await fulfillJson(route, {
        ok: true,
        workspace: WORKSPACE,
        path: FILE_PATH,
        content: INITIAL_SOURCE,
        size: INITIAL_SOURCE.length,
        mtimeMs: 1_752_739_200_000,
        version: 'version-1',
      });
      return;
    }

    await fulfillJson(route, {
      ok: true,
      workspace: WORKSPACE,
      root: { path: WORKSPACE, name: 'shiba-studio' },
      entries: [{
        name: 'src',
        path: 'src',
        kind: 'directory',
        children: [{
          name: 'app.ts',
          path: FILE_PATH,
          kind: 'file',
          size: INITIAL_SOURCE.length,
        }],
      }],
      truncated: false,
    });
  });

  await page.route('**/api/ide/git**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = await request.postDataJSON() as Record<string, unknown>;
      gitActions.push(body);
      if (body.action === 'stage') gitPhase = 'staged';
      if (body.action === 'commit') gitPhase = 'clean';
      await fulfillJson(route, {
        ok: true,
        action: body.action,
        output: '',
        ...(body.action === 'commit' ? { commitOid: 'fedcba9876543210fedcba9876543210fedcba98' } : {}),
        snapshot: gitSnapshot(gitPhase),
      });
      return;
    }

    await fulfillJson(route, { ok: true, snapshot: gitSnapshot(gitPhase) });
  });

  await page.route('**/api/ide/github**', async (route) => {
    await fulfillJson(route, {
      ok: true,
      workspace: WORKSPACE,
      configured: true,
      connected: true,
      login: 'shiba-dev',
      repository: {
        owner: 'shiba-labs',
        name: 'shiba-studio',
        fullName: 'shiba-labs/shiba-studio',
        url: 'https://github.com/shiba-labs/shiba-studio',
        defaultBranch: 'main',
        private: false,
        description: 'A local-first AI workbench.',
      },
      pullRequests: [{
        number: 42,
        title: 'Ship the Code IDE',
        url: 'https://github.com/shiba-labs/shiba-studio/pull/42',
        author: 'shiba-dev',
        head: 'development',
        base: 'main',
        draft: false,
        updatedAt: '2026-07-17T08:00:00.000Z',
      }],
      issues: [{
        number: 17,
        title: 'Polish keyboard shortcuts',
        url: 'https://github.com/shiba-labs/shiba-studio/issues/17',
        author: 'shiba-dev',
        labels: ['editor', 'ux'],
        assignees: [],
        updatedAt: '2026-07-17T08:00:00.000Z',
      }],
      workflowRuns: [{
        id: 9001,
        name: 'Code quality',
        url: 'https://github.com/shiba-labs/shiba-studio/actions/runs/9001',
        branch: 'development',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        updatedAt: '2026-07-17T08:00:00.000Z',
      }],
    });
  });

  await page.goto('/code', { waitUntil: 'domcontentloaded' });
  const codeWorkspace = page.getByLabel('Code workspace', { exact: true });
  await expect(codeWorkspace).toBeVisible();

  const sourceFolder = page.getByRole('treeitem', { name: 'src', exact: true });
  const sourceFile = page.getByRole('treeitem', { name: 'app.ts', exact: true });
  await sourceFolder.click();
  await sourceFolder.press('ArrowDown');
  await expect(sourceFile).toHaveAttribute('aria-selected', 'true');
  await sourceFile.press('Enter');
  await expect(page.getByRole('tab', { name: /app\.ts/ })).toHaveAttribute('aria-selected', 'true');

  const editor = page.locator('.monaco-editor');
  // Monaco is served from the production server and can be cold on a fresh CI
  // runner; keep this below the test timeout while allowing its first load.
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(EDITED_SOURCE);
  await expect(page.getByLabel('Unsaved changes').first()).toBeVisible();

  // Exercise the unsaved-change guard while this test's already-loaded Monaco
  // instance is active. A second Monaco boot in the same Chromium worker is
  // needlessly expensive and has been flaky in headless production runs.
  const workspacePicker = page.getByLabel('Open Code workspace');
  const cancelWorkspaceChange = new Promise<void>((resolve) => {
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('discard 1 unsaved file');
      await dialog.dismiss();
      resolve();
    });
  });
  await workspacePicker.selectOption(PROJECT_WORKSPACE_ID);
  await cancelWorkspaceChange;
  await expect(workspacePicker).toHaveValue(DEFAULT_WORKSPACE_ID);
  await expect(page.getByLabel('Unsaved changes').first()).toBeVisible();

  await page.keyboard.press('Control+S');
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    action: 'save',
    workspace: WORKSPACE,
    path: FILE_PATH,
    content: EDITED_SOURCE,
    expectedVersion: 'version-1',
  });
  await expect(page.getByLabel('Save active file')).toBeDisabled();

  await page.getByRole('button', { name: 'Source Control', exact: true }).click();
  await expect(page.getByLabel(`Stage ${FILE_PATH}`)).toBeVisible();
  await page.getByLabel(`Stage ${FILE_PATH}`).click();
  await expect.poll(() => gitActions.map((action) => action.action)).toContain('stage');
  await expect(page.getByLabel(`Unstage ${FILE_PATH}`)).toBeVisible();

  await page.getByLabel('Commit message').fill('test: save from Code');
  await page.getByRole('button', { name: 'Commit staged' }).click();
  await expect.poll(() => gitActions.map((action) => action.action)).toContain('commit');
  expect(gitActions.at(-1)).toMatchObject({
    action: 'commit',
    workspace: WORKSPACE,
    message: 'test: save from Code',
  });
  await expect(codeWorkspace).toContainText('No pending changes');

  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(codeWorkspace).toContainText('shiba-labs/shiba-studio');
  await expect(codeWorkspace).toContainText('Ship the Code IDE');

  await page.getByRole('tab', { name: /Issues/ }).click();
  await expect(codeWorkspace).toContainText('Polish keyboard shortcuts');
  await page.getByRole('tab', { name: /Actions/ }).click();
  await expect(codeWorkspace).toContainText('Code quality');
});

test('Code switches between the default workspace, a saved project, and a Git worktree', async ({ page }) => {
  const bootstrapRequests: string[] = [];
  const knownWorkspaces = new Set([WORKSPACE, PROJECT_WORKSPACE, WORKTREE_WORKSPACE]);
  const workspaceNames = new Map([
    [WORKSPACE, 'shiba-studio'],
    [PROJECT_WORKSPACE, 'saved-project'],
    [WORKTREE_WORKSPACE, 'feature-picker'],
  ]);
  const workspaceFiles = new Map([
    [WORKSPACE, 'app.ts'],
    [PROJECT_WORKSPACE, 'project.ts'],
    [WORKTREE_WORKSPACE, 'branch.ts'],
  ]);

  await mockWorkspaceOptions(page);

  await page.route('**/api/ide/files**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const requestedWorkspace = url.searchParams.get('workspace') || WORKSPACE;
    const selectedWorkspace = knownWorkspaces.has(requestedWorkspace)
      ? requestedWorkspace
      : WORKSPACE;

    if (url.searchParams.get('action') === 'read') {
      await fulfillJson(route, {
        ok: true,
        workspace: selectedWorkspace,
        path: FILE_PATH,
        content: INITIAL_SOURCE,
        size: INITIAL_SOURCE.length,
        mtimeMs: 1_752_739_200_000,
        version: 'version-1',
      });
      return;
    }

    bootstrapRequests.push(selectedWorkspace);
    const fileName = workspaceFiles.get(selectedWorkspace) || 'app.ts';
    await fulfillJson(route, {
      ok: true,
      workspace: selectedWorkspace,
      root: {
        path: selectedWorkspace,
        name: workspaceNames.get(selectedWorkspace) || 'workspace',
      },
      entries: [{
        name: 'src',
        path: 'src',
        kind: 'directory',
        children: [{
          name: fileName,
          path: `src/${fileName}`,
          kind: 'file',
          size: INITIAL_SOURCE.length,
        }],
      }],
      truncated: false,
    });
  });

  await page.route('**/api/ide/git**', async (route) => {
    const requestedWorkspace = new URL(route.request().url()).searchParams.get('workspace') || WORKSPACE;
    await fulfillJson(route, {
      ok: true,
      snapshot: {
        ...gitSnapshot('clean'),
        repoRoot: requestedWorkspace,
        workspace: requestedWorkspace,
      },
    });
  });

  await page.route('**/api/ide/github**', async (route) => {
    const requestedWorkspace = new URL(route.request().url()).searchParams.get('workspace') || WORKSPACE;
    await fulfillJson(route, {
      ok: true,
      workspace: requestedWorkspace,
      configured: false,
      connected: false,
    });
  });

  await page.goto('/code', { waitUntil: 'domcontentloaded' });

  const picker = page.getByLabel('Open Code workspace');
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue(DEFAULT_WORKSPACE_ID);
  await expect(picker.locator('option')).toHaveText([
    'Default workspace',
    'Saved project',
    'feature-picker — feature/workspace-picker',
  ]);
  const explorer = page.getByRole('complementary', { name: 'Explorer panel' });
  const expandSourceFolder = async (expectedFile: string) => {
    const expected = explorer.getByRole('treeitem', { name: expectedFile, exact: true });
    await expect.poll(async () => {
      const folder = explorer.getByRole('treeitem', { name: 'src', exact: true });
      if (!(await folder.isVisible().catch(() => false))) return false;
      if (await folder.getAttribute('aria-expanded') !== 'true') {
        await folder.press('ArrowRight').catch(() => {});
      }
      return await expected.isVisible().catch(() => false);
    }, {
      message: `wait for ${expectedFile} in the selected workspace tree`,
      timeout: 10_000,
    }).toBe(true);
  };

  await picker.selectOption(PROJECT_WORKSPACE_ID);
  await expect.poll(() => bootstrapRequests).toContain(PROJECT_WORKSPACE);
  await expect(picker).toHaveValue(PROJECT_WORKSPACE_ID);
  await expect(picker.locator('..')).toHaveAttribute('title', PROJECT_WORKSPACE);
  await expect(explorer.locator('small')).toHaveText('saved-project');
  await expandSourceFolder('project.ts');
  await expect(page.getByRole('treeitem', { name: 'project.ts', exact: true })).toBeVisible();
  await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);

  await picker.selectOption(WORKTREE_WORKSPACE_ID);
  await expect.poll(() => bootstrapRequests).toContain(WORKTREE_WORKSPACE);
  await expect(picker).toHaveValue(WORKTREE_WORKSPACE_ID);
  await expect(picker.locator('..')).toHaveAttribute('title', WORKTREE_WORKSPACE);
  await expect(explorer.locator('small')).toHaveText('feature-picker');
  await expandSourceFolder('branch.ts');
  await expect(page.getByRole('treeitem', { name: 'branch.ts', exact: true })).toBeVisible();

  await picker.selectOption(DEFAULT_WORKSPACE_ID);
  await expect.poll(() => bootstrapRequests.filter(
    (workspace) => workspace === WORKSPACE,
  ).length).toBeGreaterThan(1);
  await expect(picker).toHaveValue(DEFAULT_WORKSPACE_ID);
  await expect(picker.locator('..')).toHaveAttribute('title', WORKSPACE);
  await expect(explorer.locator('small')).toHaveText('shiba-studio');
  await expandSourceFolder('app.ts');
  await expect(page.getByRole('treeitem', { name: 'app.ts', exact: true })).toBeVisible();
});
