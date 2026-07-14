import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    failed += 1;
    console.error(`FAIL: ${message}`);
    throw new Error(message);
  }
  passed += 1;
  console.log(`ok: ${message}`);
}

function fileArg(value: unknown): string {
  if (value instanceof URL) return value.pathname;
  return String(value);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-data-loading-'));
  const data = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_PROJECT_ROOT = path.resolve(__dirname, '..');
  await fs.mkdir(workspace, { recursive: true });

  const nativeFs = process.getBuiltinModule?.('fs') as typeof import('fs');
  assert(nativeFs?.promises, 'Node filesystem promises are available');
  const nativePromises = nativeFs.promises;
  const originalReadFile = nativePromises.readFile;
  const originalStat = nativePromises.stat;

  try {
    const { saveConfig, saveAgents } = await import('../lib/persistence');
    const { dataDir } = await import('../lib/data-paths');
    const { EMPTY_INTEGRATION_SCOPE } = await import('../lib/types');
    await saveConfig({ defaultWorkspace: workspace, usageCostSource: 'local' });

    // The route used to read <cwd>/data/cloud-sync.json while the writer uses
    // SHIBA_DATA_DIR. Verify both the location and the single-snapshot read.
    const lastSyncAt = '2026-07-13T12:34:56.000Z';
    const syncPath = dataDir('cloud-sync.json');
    await fs.writeFile(syncPath, `${JSON.stringify({ files: [], lastSyncAt })}\n`, 'utf8');
    let syncReads = 0;
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = (async (...args: unknown[]) => {
      if (path.resolve(fileArg(args[0])) === path.resolve(syncPath)) syncReads += 1;
      return (originalReadFile as unknown as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as typeof nativePromises.readFile;
    const { GET: getWorkspaceSync } = await import('../app/api/workspace/sync/route');
    const syncResponse = await getWorkspaceSync();
    const syncJson = await syncResponse.json() as { ok?: boolean; lastSyncAt?: string | null };
    assert(syncJson.ok === true, 'workspace sync overview loads');
    assert(syncJson.lastSyncAt === lastSyncAt, 'workspace sync timestamp comes from SHIBA_DATA_DIR');
    assert(syncReads === 1, 'workspace sync rows and timestamp share one state-file read');
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = originalReadFile;

    const { GET: getHealth } = await import('../app/api/health/route');
    const healthResponse = getHealth();
    assert(healthResponse.status === 200 && (await healthResponse.json()).ok === true,
      'health probe is a lightweight standalone endpoint');
    const routineEditor = await fs.readFile(path.resolve(__dirname, '../components/routine-editor.tsx'), 'utf8');
    assert(routineEditor.includes('`${origin}/api/health`') && !routineEditor.includes("url: 'http://127.0.0.1:3000/api/boot'"),
      'new health automations never invoke the mutating boot endpoint');

    const uploadsDir = path.join(workspace, 'uploads');
    const largeUpload = path.join(uploadsDir, 'large-upload.txt');
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(largeUpload, 'u'.repeat(512_000), 'utf8');
    let uploadContentReads = 0;
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = (async (...args: unknown[]) => {
      if (path.resolve(fileArg(args[0])) === path.resolve(largeUpload)) uploadContentReads += 1;
      return (originalReadFile as unknown as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as typeof nativePromises.readFile;
    const { countGlobalUploadFiles } = await import('../lib/workspace');
    assert(await countGlobalUploadFiles(workspace) === 1, 'upload badge count sees visible files');
    assert(uploadContentReads === 0, 'upload badge count never reads or hashes upload contents');
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = originalReadFile;

    const target = path.join(workspace, 'target.txt');
    const unrelated = Array.from({ length: 24 }, (_, index) => path.join(workspace, `unrelated-${index}.txt`));
    await fs.writeFile(target, `# Current target\n${'x'.repeat(768_000)}`, 'utf8');
    await Promise.all(unrelated.map((file, index) => fs.writeFile(file, `# Unrelated ${index}\nbody`, 'utf8')));

    const { getDb, closeDb } = await import('../lib/db');
    const db = getDb();
    const insertRun = db.prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, workspaceSnapshot, trace
      ) VALUES (?, ?, ?, 'cloud:grok-4', 'completed', 'test', ?, ?, '', '[]', ?, ?)
    `);
    const traceFor = (files: string[]) => JSON.stringify(files.map((file, index) => ({
      id: `step-${index}`,
      ts: new Date().toISOString(),
      type: 'tool',
      content: '',
      tool: { name: 'fs_write', args: { path: path.basename(file) } },
    })));
    insertRun.run(
      'run-newest', 'agent-snapshot', 'Snapshot Agent',
      '2026-07-13T12:00:00.000Z', '2026-07-13T12:01:00.000Z', workspace,
      traceFor([target, ...unrelated]),
    );
    insertRun.run(
      'run-older', 'agent-snapshot', 'Snapshot Agent',
      '2026-07-13T11:00:00.000Z', '2026-07-13T11:01:00.000Z', workspace,
      traceFor([target]),
    );

    const { collectAllCreatedFiles, resolveCreatedFile } = await import('../lib/board-work');
    const statPaths: string[] = [];
    const readPaths: string[] = [];
    (nativePromises as unknown as { stat: typeof nativePromises.stat }).stat = (async (...args: unknown[]) => {
      statPaths.push(path.resolve(fileArg(args[0])));
      return (originalStat as unknown as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as typeof nativePromises.stat;
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = (async (...args: unknown[]) => {
      readPaths.push(path.resolve(fileArg(args[0])));
      return (originalReadFile as unknown as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as typeof nativePromises.readFile;

    const resolved = await resolveCreatedFile(target);
    assert(resolved?.runId === 'run-newest', 'path-specific resolver returns the newest producing run');
    assert(statPaths.length === 1 && statPaths[0] === path.resolve(target), 'path-specific resolver stats only the requested file');
    assert(readPaths.length === 0, 'path-specific resolver does not read previews or unrelated files');

    const { inspectFile } = await import('../lib/serve-file');
    const inspected = await inspectFile(target, path.basename(target));
    assert(inspected?.size === (await fs.stat(target)).size, 'file inspection preserves the full on-disk size');
    assert(inspected?.truncated === true && inspected.content.length <= 512 * 1024, 'file inspection reads only the bounded preview window');
    assert(!readPaths.includes(path.resolve(target)), 'file inspection does not read a large file in full');
    const emptyPath = path.join(workspace, 'empty.txt');
    const binaryPath = path.join(workspace, 'binary.bin');
    await fs.writeFile(emptyPath, '');
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
    const emptyInspect = await inspectFile(emptyPath, 'empty.txt');
    const binaryInspect = await inspectFile(binaryPath, 'binary.bin');
    assert(emptyInspect?.size === 0 && emptyInspect.content === '', 'bounded inspection preserves empty files');
    assert(binaryInspect?.binary === true && binaryInspect.size === 4, 'bounded inspection still detects binary files');

    statPaths.length = 0;
    readPaths.length = 0;
    const files = await collectAllCreatedFiles();
    const targetRows = files.filter((file) => path.resolve(file.absPath) === path.resolve(target));
    assert(targetRows.length === 1 && targetRows[0].runId === 'run-newest', 'created-file list dedupes newest-first');
    assert(statPaths.filter((file) => file === path.resolve(target)).length === 1, 'duplicate paths are statted once');
    assert(!readPaths.includes(path.resolve(target)), 'text previews do not read the whole file into memory');

    // Legacy runs without a workspace snapshot previously reloaded agents.json
    // once per run. The shared map should perform one read for the whole scan.
    await saveAgents([{
      id: 'legacy-agent',
      name: 'Legacy Agent',
      model: 'cloud:grok-4',
      description: '',
      autoAcceptBoardAssignments: false,
      workspace: { path: workspace, useWorktree: false },
      integrations: { ...EMPTY_INTEGRATION_SCOPE },
      peers: [],
      skills: [],
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:00.000Z',
    }]);
    for (const [id, name, startedAt] of [
      ['legacy-a', 'legacy-a.txt', '2026-07-13T10:00:00.000Z'],
      ['legacy-b', 'legacy-b.txt', '2026-07-13T09:00:00.000Z'],
    ] as const) {
      await fs.writeFile(path.join(workspace, name), `# ${id}\nbody`, 'utf8');
      insertRun.run(id, 'legacy-agent', 'Legacy Agent', startedAt, startedAt, null, traceFor([path.join(workspace, name)]));
    }
    readPaths.length = 0;
    await collectAllCreatedFiles();
    const agentsPath = path.resolve(dataDir('agents.json'));
    assert(readPaths.filter((file) => file === agentsPath).length === 1, 'legacy run workspaces preload agents exactly once');

    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = originalReadFile;
    (nativePromises as unknown as { stat: typeof nativePromises.stat }).stat = originalStat;
    closeDb();
  } finally {
    (nativePromises as unknown as { readFile: typeof nativePromises.readFile }).readFile = originalReadFile;
    (nativePromises as unknown as { stat: typeof nativePromises.stat }).stat = originalStat;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  failed += 1;
  console.error(error);
  process.exit(1);
});
