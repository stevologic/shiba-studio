import { promises as fs } from 'fs';
import path from 'path';
import type { AgentRun } from './types';
import { dataDir } from './data-paths';

async function ensureRunsDir(): Promise<string> {
  const dir = dataDir('runs');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function persistAgentRun(run: AgentRun): Promise<void> {
  await ensureRunsDir();
  await fs.writeFile(dataDir('runs', `${run.id}.json`), JSON.stringify(run, null, 2));
}

export async function loadRuns(agentId?: string): Promise<AgentRun[]> {
  const dir = dataDir('runs');
  try {
    const files = await fs.readdir(dir);
    const runs: AgentRun[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(dataDir('runs', f), 'utf8');
      const r = JSON.parse(raw) as AgentRun;
      if (!agentId || r.agentId === agentId) runs.push(r);
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 80);
  } catch {
    return [];
  }
}