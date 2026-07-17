import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createIdeGitHubIssue,
  createIdeGitHubPullRequest,
  IdeGitHubError,
  parseGitHubRemote,
  redactIdeGitHubText,
  resolveGitHubRepository,
} from '../lib/ide-github';
import { resolveMonacoAsset } from '../lib/monaco-assets';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-ide-github-'));
  const repository = path.join(root, 'repository');
  const assetRoot = path.join(root, 'monaco', 'vs');
  const outside = path.join(root, 'outside');
  let checks = 0;

  try {
    const validRemotes: Array<[string, string]> = [
      ['git@github.com:openai/shiba-studio.git', 'openai/shiba-studio'],
      ['github.com:openai/shiba-studio', 'openai/shiba-studio'],
      ['ssh://git@github.com/OpenAI/shiba-studio.git', 'OpenAI/shiba-studio'],
      ['https://user:secret@github.com/openai/shiba-studio.git/', 'openai/shiba-studio'],
      ['git+https://github.com/openai/shiba-studio.git', 'openai/shiba-studio'],
    ];
    for (const [remote, fullName] of validRemotes) {
      assert.equal(parseGitHubRemote(remote)?.fullName, fullName, remote);
      checks += 1;
    }

    for (const remote of [
      '',
      'https://gitlab.com/openai/shiba-studio.git',
      'file://github.com/openai/shiba-studio',
      'https://github.com/openai/shiba-studio/issues',
      'https://github.com/openai',
      'git@github.com:openai/shiba-studio/extra.git',
      'https://github.com/openai%2Fother/shiba-studio.git',
    ]) {
      assert.equal(parseGitHubRemote(remote), null, remote);
      checks += 1;
    }

    const secret = ['github', 'pat', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');
    const redacted = redactIdeGitHubText(
      `failed ${secret} at https://user:password@github.com/openai/repo.git`,
      [secret],
    );
    assert.doesNotMatch(redacted, /1234567890|user:password/);
    assert.match(redacted, /\[redacted\]/);
    checks += 1;

    await assert.rejects(
      () => createIdeGitHubIssue({
        workspace: root,
        title: 'x'.repeat(257),
      }),
      (error: unknown) => (
        error instanceof IdeGitHubError
        && error.code === 'GITHUB_TEXT_TOO_LONG'
        && error.status === 400
      ),
    );
    checks += 1;

    await assert.rejects(
      () => createIdeGitHubPullRequest({
        workspace: root,
        title: 'Valid title',
        base: 'x'.repeat(251),
      }),
      (error: unknown) => (
        error instanceof IdeGitHubError
        && error.code === 'GITHUB_TEXT_TOO_LONG'
        && error.status === 400
      ),
    );
    checks += 1;

    await fs.mkdir(repository, { recursive: true });
    git(repository, 'init');
    git(repository, 'remote', 'add', 'origin', 'git@github.com:openai/shiba-studio.git');
    assert.equal((await resolveGitHubRepository(repository))?.fullName, 'openai/shiba-studio');
    checks += 1;

    await Promise.all([
      fs.mkdir(path.join(assetRoot, 'editor'), { recursive: true }),
      fs.mkdir(outside, { recursive: true }),
    ]);
    const assetFile = path.join(assetRoot, 'editor', 'editor.main.js');
    await fs.writeFile(assetFile, 'globalThis.monaco = {};\n');
    await fs.writeFile(path.join(outside, 'secret.js'), 'do not serve\n');

    const validAsset = await resolveMonacoAsset(assetRoot, ['vs', 'editor', 'editor.main.js']);
    assert.equal(validAsset.ok, true);
    if (validAsset.ok) assert.equal(validAsset.path, await fs.realpath(assetFile));
    checks += 1;

    for (const asset of [
      ['editor', 'editor.main.js'],
      ['vs', '..', 'outside', 'secret.js'],
      ['vs', '..\\outside\\secret.js'],
      ['vs', 'editor/editor.main.js'],
      ['vs'],
    ]) {
      assert.deepEqual(await resolveMonacoAsset(assetRoot, asset), {
        ok: false,
        reason: 'invalid',
      });
      checks += 1;
    }
    assert.deepEqual(await resolveMonacoAsset(assetRoot, ['vs', 'missing.js']), {
      ok: false,
      reason: 'missing',
    });
    checks += 1;

    let symlinkCreated = false;
    try {
      await fs.symlink(
        outside,
        path.join(assetRoot, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      symlinkCreated = true;
    } catch {
      // Symlink creation can be restricted on Windows.
    }
    if (symlinkCreated) {
      assert.deepEqual(await resolveMonacoAsset(assetRoot, ['vs', 'escape', 'secret.js']), {
        ok: false,
        reason: 'invalid',
      });
      checks += 1;
    }

    const monacoRoute = await import('../app/api/monaco/[...asset]/route');
    const validResponse = await monacoRoute.GET(
      new Request('http://localhost/api/monaco/vs/loader.js'),
      { params: Promise.resolve({ asset: ['vs', 'loader.js'] }) },
    );
    assert.equal(validResponse.status, 200);
    assert.match(validResponse.headers.get('content-type') || '', /javascript/);
    assert.equal(validResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await validResponse.arrayBuffer()).byteLength > 1_000);
    checks += 1;

    const traversalResponse = await monacoRoute.GET(
      new Request('http://localhost/api/monaco/vs/%2e%2e/package.json'),
      { params: Promise.resolve({ asset: ['vs', '..', 'package.json'] }) },
    );
    assert.equal(traversalResponse.status, 400);
    checks += 1;

    console.log(`${checks} IDE GitHub/Monaco checks passed`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('IDE GitHub/Monaco verification failed', error);
  process.exit(1);
});
