import { setTimeout as delay } from 'node:timers/promises';

process.env.SHIBA_DISABLE_BOARD_DISPATCH = '1';

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'create-cards') {
    const [workerId, rawCount] = args;
    const count = Number(rawCount);
    const board = await import('../lib/board');
    for (let index = 0; index < count; index += 1) {
      await board.createBoardTask({
        id: `multiprocess-card-${workerId}-${index}`,
        title: `Multiprocess card ${workerId}-${index}`,
        status: 'todo',
      });
    }
    console.log(JSON.stringify({ ok: true, count }));
    return;
  }

  if (mode === 'add-agents') {
    const [workerId, rawCount] = args;
    const count = Number(rawCount);
    const [{ normalizeAgent }, persistence] = await Promise.all([
      import('../lib/types'),
      import('../lib/persistence'),
    ]);
    for (let index = 0; index < count; index += 1) {
      const timestamp = new Date().toISOString();
      const id = `multiprocess-agent-${workerId}-${index}`;
      await persistence.mutateAgents((agents) => {
        if (agents.some((agent) => agent.id === id)) return;
        agents.push(normalizeAgent({
          id,
          name: `Multiprocess Agent ${workerId}-${index}`,
          model: 'local:board-concurrency-verifier',
          description: 'Cross-process JSON store verifier',
          autoAcceptBoardAssignments: false,
          workspace: { path: process.env.SHIBA_DATA_DIR || process.cwd(), useWorktree: false },
          integrations: {},
          peers: [],
          skills: [],
          schedules: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        }));
      });
    }
    console.log(JSON.stringify({ ok: true, count }));
    return;
  }

  if (mode === 'claim') {
    const [cardId, workId, taskId, agentId] = args;
    const board = await import('../lib/board');
    const result = await board.claimBoardWork({
      idOrKey: cardId,
      workId,
      taskId,
      agentId,
      agentName: 'Claim Agent',
      mode: 'manual',
    });
    console.log(JSON.stringify({ claimed: result.claimed, busy: result.busy, cardId }));
    return;
  }

  if (mode === 'hold-lock') {
    const [target, rawDuration] = args;
    const duration = Math.max(1, Number(rawDuration) || 1);
    const { withStoreFileLock } = await import('../lib/store-file-lock');
    await withStoreFileLock(target, async () => {
      console.log('LOCKED');
      await delay(duration);
    });
    return;
  }

  throw new Error(`Unknown board concurrency child mode: ${mode || '(missing)'}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

