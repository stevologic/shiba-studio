import './verify-isolate'; // MUST be first: never touch live Studio data.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TraceStep } from '../lib/types';

process.env.SHIBA_DISABLE_BOARD_DISPATCH = '1';

function traceStep(
  id: string,
  type: 'tool' | 'result',
  name: string,
  args: Record<string, unknown>,
  result?: unknown,
  content = '',
): TraceStep {
  return {
    id,
    ts: new Date().toISOString(),
    type,
    content,
    tool: { name, args, ...(result === undefined ? {} : { result }) },
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-board-work-security-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const outsideDir = path.join(root, 'outside');
  const escapeLink = path.join(workspace, 'escape');
  process.env.SHIBA_DATA_DIR = dataDir;
  process.env.SHIBA_PROJECT_ROOT = path.resolve(__dirname, '..');
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(outsideDir, { recursive: true }),
  ]);

  const fileContents: Record<string, string> = {
    'legacy.txt': 'legacy successful write\n',
    'modern.txt': 'modern successful write\n',
    'generated.png': 'generated image fixture\n',
    'denied.txt': 'pre-existing file, denied write must not claim it\n',
    'denied-string.txt': 'pre-existing file, string-denied write must not claim it\n',
    'failed.png': 'pre-existing file, failed generation must not claim it\n',
  };
  await Promise.all(Object.entries(fileContents).map(([name, content]) => (
    fs.writeFile(path.join(workspace, name), content)
  )));
  const outsideAbsolute = path.join(outsideDir, 'absolute-secret.txt');
  const outsideTraversal = path.join(outsideDir, 'traversal-secret.txt');
  const outsideSymlink = path.join(outsideDir, 'symlink-secret.txt');
  await Promise.all([
    fs.writeFile(outsideAbsolute, 'outside absolute-path secret\n'),
    fs.writeFile(outsideTraversal, 'outside traversal secret\n'),
    fs.writeFile(outsideSymlink, 'outside symlink secret\n'),
  ]);
  let symlinkFixtureAvailable = true;
  try {
    await fs.symlink(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(code || '')) throw error;
    symlinkFixtureAvailable = false;
    console.warn(`SKIP symlink escape fixture: ${code}`);
  }

  const nativeFs = process.getBuiltinModule?.('fs') as typeof import('fs');
  const originalStat = nativeFs.promises.stat;

  let closeDb: (() => void) | undefined;
  try {
    const [{ saveConfig }, dbModule, board, boardWork] = await Promise.all([
      import('../lib/persistence'),
      import('../lib/db'),
      import('../lib/board'),
      import('../lib/board-work'),
    ]);
    closeDb = dbModule.closeDb;
    await saveConfig({ defaultWorkspace: workspace });

    const insertRun = dbModule.getDb().prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, workspaceSnapshot, trace
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const runIds: string[] = [];
    const insert = (id: string, trace: TraceStep[], offsetMinutes: number) => {
      const startedAt = new Date(Date.UTC(2026, 6, 17, 12, offsetMinutes, 0)).toISOString();
      const completedAt = new Date(Date.UTC(2026, 6, 17, 12, offsetMinutes, 30)).toISOString();
      insertRun.run(
        id,
        'board-work-security-agent',
        'Board Work Security Agent',
        'cloud:grok-4',
        'completed',
        'Security regression fixture',
        startedAt,
        completedAt,
        'Security fixture completed.',
        '[]',
        workspace,
        JSON.stringify(trace),
      );
      runIds.push(id);
    };

    // Compatibility control: old successful runs contained tool-only fs_write
    // traces. The in-workspace file must remain visible, while absolute,
    // traversal, and symlink escapes in the same legacy format must not.
    const legacyTrace = [
      traceStep('legacy-ok', 'tool', 'fs_write', { path: 'legacy.txt' }),
      traceStep('legacy-absolute', 'tool', 'fs_write', { path: outsideAbsolute }),
      traceStep('legacy-traversal', 'tool', 'fs_write', { path: path.relative(workspace, outsideTraversal) }),
      ...(symlinkFixtureAvailable
        ? [traceStep('legacy-symlink', 'tool', 'fs_write', { path: path.join('escape', 'symlink-secret.txt') })]
        : []),
    ];
    insert('legacy-trace-run', legacyTrace, 1);

    // Modern successful results remain deliverables.
    insert('successful-result-run', [
      traceStep('modern-attempt', 'tool', 'fs_write', { path: 'modern.txt' }),
      traceStep('modern-result', 'result', 'fs_write', { path: 'modern.txt' }, 'wrote modern.txt'),
      traceStep(
        'image-result',
        'result',
        'generate_image',
        { prompt: 'fixture' },
        { path: 'generated.png' },
      ),
    ], 2);

    // A target may already exist. Denied/failed results must never claim it as
    // work merely because the preceding attempt or result names that path.
    insert('rejected-result-run', [
      traceStep('denied-attempt', 'tool', 'fs_write', { path: 'denied.txt' }),
      traceStep(
        'denied-result',
        'result',
        'fs_write',
        { path: 'denied.txt' },
        { denied: true, reason: 'not approved' },
        'Tool execution denied',
      ),
      traceStep(
        'failed-image-result',
        'result',
        'generate_image',
        { prompt: 'fixture' },
        { path: 'failed.png', ok: false, error: 'generation failed' },
        'Image generation failed',
      ),
      traceStep('denied-string-attempt', 'tool', 'fs_write', { path: 'denied-string.txt' }),
      traceStep(
        'denied-string-result',
        'result',
        'fs_write',
        { path: 'denied-string.txt' },
        'permission denied',
      ),
      traceStep(
        'outside-image-result',
        'result',
        'generate_image',
        { prompt: 'fixture' },
        { path: outsideAbsolute },
      ),
    ], 3);

    const card = await board.createBoardTask({ title: 'Board work security fixture', status: 'done' });
    for (const runId of runIds) {
      await board.updateBoardTask(card.id, { addRunId: runId, actor: 'security verifier' });
    }

    const statPaths: string[] = [];
    nativeFs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
      statPaths.push(path.resolve(String(args[0])));
      return originalStat(...args);
    }) as typeof originalStat;

    const cardWork = await boardWork.collectCardWork(card.id);
    const cardNames = new Set(cardWork?.files.map((file) => file.name));
    assert(cardNames.has('legacy.txt'), 'legacy successful tool-only fs_write remains visible');
    assert(cardNames.has('modern.txt'), 'successful fs_write result remains visible');
    assert(cardNames.has('generated.png'), 'successful generate_image result remains visible');
    assert(!cardNames.has('denied.txt'), 'denied fs_write attempt is not a card deliverable');
    assert(!cardNames.has('denied-string.txt'), 'string-denied fs_write result is not a card deliverable');
    assert(!cardNames.has('failed.png'), 'failed generate_image result is not a card deliverable');
    assert(!cardNames.has('absolute-secret.txt'), 'absolute fs_write/generate_image paths are not card deliverables');
    assert(!cardNames.has('traversal-secret.txt'), '../ traversal paths are not card deliverables');
    if (symlinkFixtureAvailable) {
      assert(!cardNames.has('symlink-secret.txt'), 'symlink escapes are not card deliverables');
    }

    const canonicalLegacy = await fs.realpath(path.join(workspace, 'legacy.txt'));
    const canonicalDenied = await fs.realpath(path.join(workspace, 'denied.txt'));
    const canonicalOutside = await fs.realpath(outsideAbsolute);
    assert(
      (await boardWork.resolveCardDeliverable(card.id, canonicalLegacy))?.name === 'legacy.txt',
      'the card capability still resolves a legitimate in-workspace legacy deliverable',
    );
    assert.equal(
      await boardWork.resolveCardDeliverable(card.id, canonicalDenied),
      null,
      'the card capability rejects a denied write target even when that file exists',
    );
    assert.equal(
      await boardWork.resolveCardDeliverable(card.id, canonicalOutside),
      null,
      'the card capability rejects an outside-workspace path',
    );

    const globalFiles = await boardWork.collectAllCreatedFiles();
    const globalNames = new Set(globalFiles.map((file) => file.name));
    assert(globalNames.has('legacy.txt') && globalNames.has('modern.txt') && globalNames.has('generated.png'));
    assert(
      !globalNames.has('denied.txt')
      && !globalNames.has('denied-string.txt')
      && !globalNames.has('failed.png')
      && !globalNames.has('absolute-secret.txt')
      && !globalNames.has('traversal-secret.txt')
      && !globalNames.has('symlink-secret.txt'),
    );
    assert.equal(
      await boardWork.resolveCreatedFile(canonicalOutside),
      null,
      'the global Files capability rejects an outside-workspace path',
    );
    assert(
      !statPaths.some((candidate) => candidate === canonicalOutside || candidate.startsWith(`${outsideDir}${path.sep}`)),
      'outside-workspace trace paths are rejected before filesystem stat or preview access',
    );

    console.log('Board work security verification passed');
  } finally {
    nativeFs.promises.stat = originalStat;
    closeDb?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Board work security verification failed', error);
  process.exit(1);
});
