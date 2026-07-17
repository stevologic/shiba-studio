import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createIdeEntry,
  deleteIdeEntry,
  IDE_WORKSPACE_LIMITS,
  IdeWorkspaceError,
  listIdeDirectory,
  normalizeIdeRelativePath,
  readIdeTextFile,
  renameIdeEntry,
  saveIdeTextFile,
  searchIdeWorkspace,
} from '../lib/ide-workspace';

function isIdeError(code: IdeWorkspaceError['code']) {
  return (error: unknown): boolean => error instanceof IdeWorkspaceError && error.code === code;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-ide-files-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-ide-outside-'));
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks += 1;
  };

  try {
    await Promise.all([
      fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true }),
      fs.mkdir(path.join(root, '.github'), { recursive: true }),
      fs.mkdir(path.join(root, '.git'), { recursive: true }),
      fs.mkdir(path.join(root, 'node_modules'), { recursive: true }),
      fs.mkdir(path.join(root, '.next'), { recursive: true }),
      fs.mkdir(path.join(root, 'dist'), { recursive: true }),
      fs.mkdir(path.join(root, 'build'), { recursive: true }),
      fs.mkdir(path.join(root, 'coverage'), { recursive: true }),
      fs.mkdir(path.join(root, '.worktrees'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, '.gitignore'), 'local-only.txt\n'),
      fs.writeFile(path.join(root, '.hidden-note'), 'needle [literal]\n'),
      fs.writeFile(path.join(root, 'src', 'index.ts'), 'const value = "needle [literal]";\n'),
      fs.writeFile(path.join(root, 'src', 'nested', 'deep.ts'), 'export const deep = true;\n'),
      fs.writeFile(path.join(root, '.git', 'secret.txt'), 'needle [literal]\n'),
      fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n'),
    ]);

    const rootListing = await listIdeDirectory(root);
    const rootNames = new Set(rootListing.entries.map((entry) => entry.name));
    check(rootNames.has('.github') && rootNames.has('.gitignore') && rootNames.has('.hidden-note'), 'safe dotfiles are visible');
    for (const excluded of ['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.worktrees']) {
      check(!rootNames.has(excluded), `${excluded} is excluded`);
    }
    check(!rootListing.entries.some((entry) => entry.path.endsWith('deep.ts')), 'directory listing is lazy, not recursive');

    const srcListing = await listIdeDirectory(root, 'src');
    check(
      srcListing.entries.some((entry) => entry.path === 'src/nested' && entry.isDirectory)
        && srcListing.entries.some((entry) => entry.path === 'src/index.ts' && !entry.isDirectory),
      'one requested directory level is listed',
    );

    assert.throws(() => normalizeIdeRelativePath('../outside'), isIdeError('PATH_OUTSIDE_WORKSPACE'));
    checks += 1;
    await assert.rejects(() => listIdeDirectory(root, '.git'), isIdeError('PATH_EXCLUDED'));
    checks += 1;

    const initial = await readIdeTextFile(root, 'src/index.ts');
    check(initial.content.includes('needle [literal]') && /^[a-f0-9]{64}$/.test(initial.version), 'text reads return content and a version');

    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await assert.rejects(() => readIdeTextFile(root, 'binary.bin'), isIdeError('BINARY_FILE'));
    checks += 1;

    await fs.writeFile(
      path.join(root, 'too-large.txt'),
      Buffer.alloc(IDE_WORKSPACE_LIMITS.maxTextFileBytes + 1, 0x61),
    );
    await assert.rejects(() => readIdeTextFile(root, 'too-large.txt'), isIdeError('TEXT_FILE_TOO_LARGE'));
    checks += 1;

    await createIdeEntry(root, 'notes', 'directory');
    await createIdeEntry(root, 'notes/new.txt', 'file', 'first\n');
    const created = await readIdeTextFile(root, 'notes/new.txt');
    const saved = await saveIdeTextFile(root, 'notes/new.txt', 'second\n', created.version);
    check(saved.content === 'second\n' && saved.version !== created.version, 'save atomically returns the new version');

    await fs.writeFile(path.join(root, 'notes', 'new.txt'), 'external change\n');
    await assert.rejects(
      () => saveIdeTextFile(root, 'notes/new.txt', 'stale overwrite\n', saved.version),
      isIdeError('FILE_CHANGED'),
    );
    checks += 1;
    await saveIdeTextFile(root, 'notes/new.txt', 'explicit overwrite\n');

    const renamed = await renameIdeEntry(root, 'notes/new.txt', 'notes/renamed.txt');
    check(renamed.path === 'notes/renamed.txt', 'rename stays workspace-relative');
    await assert.rejects(
      () => deleteIdeEntry(root, 'notes'),
      isIdeError('DIRECTORY_NOT_EMPTY'),
    );
    checks += 1;
    const deleted = await deleteIdeEntry(root, 'notes', { recursive: true });
    check(deleted.kind === 'directory', 'recursive deletion is explicit');

    let symlinkCreated = false;
    try {
      await fs.symlink(
        outside,
        path.join(root, 'escape-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      symlinkCreated = true;
    } catch {
      // Some locked-down Windows environments deny symlink creation.
    }
    if (symlinkCreated) {
      const safeListing = await listIdeDirectory(root);
      check(!safeListing.entries.some((entry) => entry.name === 'escape-link'), 'out-of-workspace symlinks are hidden');
      await assert.rejects(
        () => readIdeTextFile(root, 'escape-link/secret.txt'),
        isIdeError('PATH_OUTSIDE_WORKSPACE'),
      );
      checks += 1;
    }

    const fastSearch = await searchIdeWorkspace(root, 'needle [literal]', { limit: 1 });
    check(
      fastSearch.matches.length === 1
        && fastSearch.matches[0].path !== '.git/secret.txt'
        && fastSearch.truncated,
      'ripgrep search is literal, excluded, and capped',
    );

    const fallbackSearch = await searchIdeWorkspace(root, 'needle [literal]', {
      limit: 10,
      ripgrepCommand: `missing-rg-${Date.now()}`,
    });
    check(
      fallbackSearch.engine === 'fallback'
        && fallbackSearch.matches.length === 2
        && fallbackSearch.matches.every((match) => !match.path.startsWith('.git/')),
      'missing ripgrep uses the bounded safe fallback',
    );

    console.log(`${checks} passed, 0 failed`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('IDE file verification failed', error);
  process.exit(1);
});
