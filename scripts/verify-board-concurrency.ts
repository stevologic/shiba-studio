import './verify-isolate'; // MUST be first: never touch the live Board/agent stores
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

interface ChildRun {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CHILD = path.join(ROOT, 'scripts', 'verify-board-concurrency-child.ts');

function startChild(args: string[], dataDir: string): ChildRun {
  const child = spawn(process.execPath, [TSX_CLI, CHILD, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHIBA_DATA_DIR: dataDir,
      SHIBA_SECRET_KEY: process.env.SHIBA_SECRET_KEY,
      SHIBA_DISABLE_BOARD_DISPATCH: '1',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run: ChildRun = {
    child,
    stdout: '',
    stderr: '',
    completed: Promise.resolve({ code: null, signal: null }),
  };
  child.stdout.on('data', (chunk) => { run.stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { run.stderr += String(chunk); });
  run.completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return run;
}

async function waitForOutput(run: ChildRun, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!run.stdout.includes(text)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`Child exited before ${JSON.stringify(text)}\n${run.stdout}\n${run.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for child output ${JSON.stringify(text)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runChild(args: string[], dataDir: string): Promise<string> {
  const run = startChild(args, dataDir);
  const timeout = setTimeout(() => run.child.kill(), 60_000);
  timeout.unref?.();
  try {
    const result = await run.completed;
    if (result.code !== 0) {
      throw new Error(`Child failed (${result.code ?? result.signal})\n${run.stdout}\n${run.stderr}`);
    }
    return run.stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

function lastJson<T>(output: string): T {
  const line = output.split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error('Child did not return JSON output');
  return JSON.parse(line) as T;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-board-concurrency-'));
  const dataDir = path.join(root, 'data');
  process.env.SHIBA_DATA_DIR = dataDir;
  process.env.SHIBA_SECRET_KEY = '47'.repeat(32);
  process.env.SHIBA_DISABLE_BOARD_DISPATCH = '1';
  await fs.mkdir(dataDir, { recursive: true });

  const [board, persistence, types, storeLocks] = await Promise.all([
    import('../lib/board'),
    import('../lib/persistence'),
    import('../lib/types'),
    import('../lib/store-file-lock'),
  ]);

  try {
    const workerCount = 8;
    const writesPerWorker = 25;
    await Promise.all(Array.from({ length: workerCount }, (_, worker) => (
      runChild(['create-cards', String(worker), String(writesPerWorker)], dataDir)
    )));

    const cards = await board.listBoardTasks();
    const boardStore = JSON.parse(await fs.readFile(path.join(dataDir, 'board.json'), 'utf8')) as {
      nextNumber: number;
      tasks: Array<{ id: string; key: string }>;
    };
    assert.equal(cards.length, workerCount * writesPerWorker, 'concurrent card writes must not be lost');
    assert.equal(new Set(cards.map((card) => card.id)).size, cards.length, 'card ids remain unique');
    assert.equal(new Set(cards.map((card) => card.key)).size, cards.length, 'SHIB keys remain unique');
    assert.equal(boardStore.nextNumber, cards.length + 1, 'the monotonic Board key counter remains exact');

    await Promise.all(Array.from({ length: workerCount }, (_, worker) => (
      runChild(['add-agents', String(worker), String(writesPerWorker)], dataDir)
    )));
    const agents = await persistence.loadAgents();
    assert.equal(agents.length, workerCount * writesPerWorker, 'concurrent agent mutations must not be lost');
    assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length, 'agent ids remain unique');

    const timestamp = new Date().toISOString();
    await persistence.mutateAgents((current) => {
      current.push(types.normalizeAgent({
        id: 'multiprocess-claim-agent',
        name: 'Claim Agent',
        model: 'local:board-concurrency-verifier',
        description: 'Same-agent claim verifier',
        autoAcceptBoardAssignments: false,
        workspace: { path: dataDir, useWorktree: false },
        integrations: {},
        peers: [],
        skills: [],
        schedules: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    });
    const claimCards = await Promise.all([
      board.createBoardTask({ title: 'Cross-process claim A', status: 'todo', assigneeAgentId: 'multiprocess-claim-agent' }),
      board.createBoardTask({ title: 'Cross-process claim B', status: 'todo', assigneeAgentId: 'multiprocess-claim-agent' }),
    ]);
    const claimOutputs = await Promise.all(claimCards.map((card, index) => runChild([
      'claim', card.id, `cross-process-work-${index}`, `cross-process-task-${index}`, 'multiprocess-claim-agent',
    ], dataDir)));
    const claims = claimOutputs.map((output) => lastJson<{ claimed: boolean; busy: boolean }>(output));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1, 'only one same-agent Board claim wins across processes');
    assert.equal(claims.filter((claim) => claim.busy).length, 1, 'the losing same-agent claim observes the busy fence');
    const claimedCards = await Promise.all(claimCards.map((card) => board.getBoardTask(card.id)));
    assert.equal(claimedCards.filter((card) => card?.activeWork).length, 1, 'exactly one active claim is persisted');

    const boardPath = path.join(dataDir, 'board.json');
    const activeLock = storeLocks.storeFileLockActivePath(boardPath);
    const liveHolder = startChild(['hold-lock', boardPath, '600'], dataDir);
    await waitForOutput(liveHolder, 'LOCKED');
    const waitStarted = Date.now();
    await board.createBoardTask({ title: 'Wait for live lock', status: 'backlog' });
    const waitedMs = Date.now() - waitStarted;
    const liveResult = await liveHolder.completed;
    assert.equal(liveResult.code, 0, liveHolder.stderr);
    assert.ok(waitedMs >= 250, `a live owner must not be reaped (waited ${waitedMs}ms)`);

    const deadHolder = startChild(['hold-lock', boardPath, '60000'], dataDir);
    await waitForOutput(deadHolder, 'LOCKED');
    deadHolder.child.kill();
    await deadHolder.completed;
    await Promise.all([
      runChild(['create-cards', 'dead-reaper-a', '1'], dataDir),
      runChild(['create-cards', 'dead-reaper-b', '1'], dataDir),
    ]);
    await board.createBoardTask({ title: 'Recover dead lock owner', status: 'backlog' });
    const afterConcurrentReap = await board.listBoardTasks();
    assert.ok(
      afterConcurrentReap.some((card) => card.id === 'multiprocess-card-dead-reaper-a-0')
        && afterConcurrentReap.some((card) => card.id === 'multiprocess-card-dead-reaper-b-0'),
      'simultaneous stale reapers cannot remove a newly acquired lock generation',
    );
    await assert.rejects(
      fs.access(activeLock),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
      'a dead owner lock is reaped and released',
    );

    await fs.mkdir(activeLock);
    const oldMissingOwner = new Date(Date.now() - 10_000);
    await fs.utimes(activeLock, oldMissingOwner, oldMissingOwner);
    await Promise.all([
      runChild(['create-cards', 'missing-owner-reaper-a', '1'], dataDir),
      runChild(['create-cards', 'missing-owner-reaper-b', '1'], dataDir),
    ]);
    const afterMissingOwnerReap = await board.listBoardTasks();
    assert.ok(
      afterMissingOwnerReap.some((card) => card.id === 'multiprocess-card-missing-owner-reaper-a-0')
        && afterMissingOwnerReap.some((card) => card.id === 'multiprocess-card-missing-owner-reaper-b-0'),
      'simultaneous reapers cannot replace a sealed empty lock tombstone with a live generation',
    );
    await assert.rejects(
      fs.access(activeLock),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
      'an old lock missing its owner record is recoverable',
    );

    await fs.mkdir(activeLock);
    await fs.writeFile(path.join(activeLock, 'owner.json'), '{not-json', 'utf8');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(activeLock, old, old);
    await board.createBoardTask({ title: 'Recover malformed abandoned lock', status: 'backlog' });
    await assert.rejects(
      fs.access(activeLock),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
      'an old malformed lock is recoverable',
    );
    await fs.mkdir(activeLock);
    await fs.writeFile(path.join(activeLock, 'owner.json'), '{not-json', 'utf8');
    await fs.utimes(activeLock, old, old);
    await board.createBoardTask({ title: 'Recover repeated malformed generation', status: 'backlog' });
    await assert.rejects(
      fs.access(activeLock),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
      'a later malformed generation with identical bytes gets an independent reap identity',
    );

    let deferredLockCheck!: Promise<boolean>;
    await storeLocks.withStoreFileLock(boardPath, async () => {
      deferredLockCheck = new Promise<boolean>((resolve, reject) => {
        setTimeout(() => {
          storeLocks.withStoreFileLock(boardPath, async () => {
            try {
              await fs.access(activeLock);
              resolve(true);
            } catch (error) {
              reject(error);
            }
          }).catch(reject);
        }, 50);
      });
    });
    assert.equal(
      await deferredLockCheck,
      true,
      'fire-and-forget async descendants reacquire after the parent lock context expires',
    );

    if (process.platform === 'win32') {
      let heldDirectory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
      await storeLocks.withStoreFileLock(boardPath, async () => {
        heldDirectory = await fs.opendir(activeLock);
        setTimeout(() => { void heldDirectory?.close(); }, 250);
      });
      await assert.rejects(
        fs.access(activeLock),
        (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
        'Windows release does not abandon a live-PID active generation',
      );
    }

    console.log('Board cross-process concurrency verification passed');
  } finally {
    await (await import('../lib/board-runner')).stopBoardAssignmentProcessor();
    (await import('../lib/db')).closeDb();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(code)) || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
}

main().catch((error) => {
  console.error('Board cross-process concurrency verification failed', error);
  process.exitCode = 1;
});
