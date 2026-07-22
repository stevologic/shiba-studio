import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyIdeGitAction,
  getIdeGitFileDiff,
  getIdeGitSnapshot,
  IdeGitError,
} from '../lib/ide-git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

async function expectIdeGitError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof IdeGitError);
    assert.equal(error.code, code);
    return true;
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-ide-git-'));
  const repository = path.join(root, 'repository');
  const remote = path.join(root, 'origin.git');
  try {
    await fs.mkdir(repository, { recursive: true });
    const canonicalRepository = await fs.realpath(repository);
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'base\n');
    await fs.writeFile(path.join(repository, 'leave.txt'), 'base\n');
    await fs.writeFile(path.join(repository, 'rename-source.txt'), 'rename me\n');
    await fs.writeFile(path.join(repository, 'conflict.txt'), 'base\n');
    git(repository, 'init');
    git(repository, 'branch', '-M', 'main');
    git(repository, 'config', 'core.autocrlf', 'false');
    git(repository, 'config', 'user.email', 'ide-git@example.invalid');
    git(repository, 'config', 'user.name', 'IDE Git Verifier');
    git(repository, 'config', 'commit.gpgSign', 'false');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'baseline');

    git(repository, 'switch', '-c', 'other');
    await fs.writeFile(path.join(repository, 'conflict.txt'), 'other\n');
    git(repository, 'add', 'conflict.txt');
    git(repository, 'commit', '-m', 'other conflict change');
    git(repository, 'switch', 'main');
    await fs.writeFile(path.join(repository, 'conflict.txt'), 'main\n');
    git(repository, 'add', 'conflict.txt');
    git(repository, 'commit', '-m', 'main conflict change');

    await fs.mkdir(remote, { recursive: true });
    git(remote, 'init', '--bare');
    git(repository, 'remote', 'add', 'origin', remote);
    git(repository, 'remote', 'add', 'github', 'git@github.com:example/shiba-ide-fixture.git');
    git(repository, 'push', '--quiet', '-u', 'origin', 'main');

    assert.throws(
      () => git(repository, 'merge', 'other'),
      /Command failed/,
      'fixture produces an unmerged porcelain-v2 record',
    );
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'staged\n');
    git(repository, 'add', 'tracked.txt');
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'working\n');
    git(repository, 'mv', 'rename-source.txt', 'renamed.txt');
    await fs.writeFile(path.join(repository, 'untracked.txt'), 'untracked\n');
    await fs.mkdir(path.join(repository, 'untracked-dir'));
    await fs.writeFile(path.join(repository, 'untracked-dir', 'child.txt'), 'keep\n');

    const conflictedSnapshot = await getIdeGitSnapshot(repository);
    assert.equal(
      await fs.realpath(conflictedSnapshot.repoRoot),
      canonicalRepository,
      'repository roots are compared after resolving platform path aliases',
    );
    assert.equal(conflictedSnapshot.head.branch, 'main');
    assert.equal(conflictedSnapshot.upstream, 'origin/main');
    assert.equal(conflictedSnapshot.ahead, 0);
    assert.equal(conflictedSnapshot.behind, 0);
    assert.equal(conflictedSnapshot.github?.slug, 'example/shiba-ide-fixture');
    assert.ok(
      conflictedSnapshot.status.some((entry) => entry.path === 'conflict.txt' && entry.conflicted),
      'unmerged record is parsed as a conflict',
    );
    assert.ok(
      conflictedSnapshot.status.some((entry) => entry.path === 'tracked.txt' && entry.staged && entry.unstaged),
      'mixed index/worktree state is preserved',
    );
    assert.ok(
      conflictedSnapshot.status.some((entry) => entry.path === 'untracked.txt' && entry.untracked),
      'untracked file is represented',
    );
    assert.ok(
      conflictedSnapshot.status.some((entry) => (
        entry.path === 'renamed.txt'
        && entry.originalPath === 'rename-source.txt'
        && entry.renamed
      )),
      'rename source and destination are represented',
    );

    const workingDiff = await getIdeGitFileDiff(repository, 'tracked.txt', 'working');
    assert.equal(workingDiff.original?.content, 'staged\n');
    assert.equal(workingDiff.modified?.content, 'working\n');
    assert.match(workingDiff.patch, /working/);
    const stagedDiff = await getIdeGitFileDiff(repository, 'tracked.txt', 'staged');
    assert.equal(stagedDiff.original?.content, 'base\n');
    assert.equal(stagedDiff.modified?.content, 'staged\n');

    await expectIdeGitError(
      () => applyIdeGitAction(repository, { action: 'discard', paths: ['conflict.txt'] }),
      'CONFLICTED_PATH',
    );
    await expectIdeGitError(
      () => applyIdeGitAction(repository, { action: 'stage', paths: ['../outside.txt'] }),
      'INVALID_GIT_PATH',
    );
    await expectIdeGitError(
      () => applyIdeGitAction(repository, { action: 'discard', paths: ['untracked-dir'] }),
      'NO_DISCARDABLE_CHANGE',
    );
    assert.equal(
      await fs.readFile(path.join(repository, 'untracked-dir', 'child.txt'), 'utf8'),
      'keep\n',
      'discard never recursively removes an untracked directory',
    );

    await applyIdeGitAction(repository, { action: 'discard', paths: ['untracked.txt'] });
    assert.equal(await fs.stat(path.join(repository, 'untracked.txt')).catch(() => null), null);
    await applyIdeGitAction(repository, { action: 'discard', paths: ['tracked.txt'] });
    assert.equal(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8'), 'staged\n');
    await applyIdeGitAction(repository, { action: 'unstage', paths: ['tracked.txt'] });
    const unstagedSnapshot = await getIdeGitSnapshot(repository);
    assert.ok(
      unstagedSnapshot.status.some((entry) => entry.path === 'tracked.txt' && !entry.staged && entry.unstaged),
    );

    git(repository, 'checkout', '--ours', 'conflict.txt');
    git(repository, 'add', 'conflict.txt');
    await applyIdeGitAction(repository, { action: 'stage', paths: ['tracked.txt'] });
    await fs.writeFile(path.join(repository, 'leave.txt'), 'leave this unstaged\n');
    const committed = await applyIdeGitAction(repository, {
      action: 'commit',
      message: 'structured IDE commit',
    });
    assert.ok(committed.commitOid);
    assert.ok(
      committed.snapshot.status.some((entry) => entry.path === 'leave.txt' && entry.unstaged && !entry.staged),
      'commit records staged changes only',
    );

    await applyIdeGitAction(repository, { action: 'push' });
    const created = await applyIdeGitAction(repository, {
      action: 'createBranch',
      branch: 'feature/structured-git',
    });
    assert.equal(created.snapshot.head.branch, 'feature/structured-git');
    const firstBranchPush = await applyIdeGitAction(repository, { action: 'push' });
    assert.equal(firstBranchPush.snapshot.upstream, 'origin/feature/structured-git');
    const checkedOut = await applyIdeGitAction(repository, { action: 'checkout', branch: 'main' });
    assert.equal(checkedOut.snapshot.head.branch, 'main');
    await applyIdeGitAction(repository, { action: 'fetch', remote: 'origin' });
    await applyIdeGitAction(repository, { action: 'pull' });

    const [{ NextRequest }, route] = await Promise.all([
      import('next/server'),
      import('../app/api/ide/git/route'),
    ]);
    const response = await route.GET(new NextRequest(
      `http://localhost/api/ide/git?workspace=${encodeURIComponent(repository)}`,
    ));
    assert.equal(response.status, 200);
    const payload = await response.json() as { ok?: boolean; snapshot?: { repoRoot?: string } };
    assert.equal(payload.ok, true);
    assert.ok(payload.snapshot?.repoRoot);
    assert.equal(
      await fs.realpath(payload.snapshot.repoRoot),
      canonicalRepository,
      'API repository roots are compared after resolving platform path aliases',
    );

    console.log('IDE Git verification passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('IDE Git verification failed', error);
  process.exit(1);
});
