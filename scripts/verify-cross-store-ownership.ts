import './verify-isolate';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../lib/types';

function agent(id: string, workspace: string): Agent {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    model: 'test-model',
    autoAcceptBoardAssignments: false,
    workspace: { path: workspace, useWorktree: false },
    integrations: {
      github: false,
      slack: false,
      googledrive: false,
      discord: false,
      x: false,
      reddit: false,
      obsidian: false,
      vercel: false,
      netlify: false,
    },
    peers: [],
    skills: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-cross-store-ownership-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = 'd3'.repeat(32);

  const db = await import('../lib/db');
  const persistence = await import('../lib/persistence');
  const projects = await import('../lib/projects');
  const coordinator = await import('../lib/integrity-coordinator');

  try {
    await persistence.saveAgents([agent('live-agent', root)]);
    const project = await projects.createProject('Owned project');
    await projects.updateProject(project.id, { defaultAgentId: 'live-agent' });
    await persistence.saveConfig({
      integrations: {
        slack: { token: 'slack-test-token', mentionAgentId: 'live-agent' },
        discord: { token: 'discord-test-token', mentionAgentId: 'missing-agent' },
      },
    });

    const first = await coordinator.reconcileAllDataIntegrity({
      reason: 'cross-store ownership verification',
      includeStorage: false,
      includeExternalCleanup: false,
    });
    assert.equal(first.integrationMentionAgentsDetached, 1);
    assert.equal(first.projectDefaultAgentsDetached, 0);
    let config = await persistence.loadConfig();
    assert.equal(config.integrations.slack?.mentionAgentId, 'live-agent');
    assert.equal(config.integrations.discord?.mentionAgentId, undefined);
    assert.equal((await projects.getProject(project.id))?.defaultAgentId, 'live-agent');

    await persistence.mutateAgents((agents) => {
      agents.splice(0, agents.length);
    });
    const afterDelete = await coordinator.reconcileAllDataIntegrity({
      reason: 'deleted agent ownership verification',
      includeStorage: false,
      includeExternalCleanup: false,
    });
    assert.equal(afterDelete.integrationMentionAgentsDetached, 1);
    assert.equal(afterDelete.projectDefaultAgentsDetached, 1);
    config = await persistence.loadConfig();
    assert.equal(config.integrations.slack?.mentionAgentId, undefined);
    assert.equal((await projects.getProject(project.id))?.defaultAgentId, '');

    let creation: Promise<void> | null = null;
    let creationCompleted = false;
    await persistence.withAgentOwnershipSnapshot(async () => {
      creation = persistence.mutateAgents((agents) => {
        agents.push(agent('new-agent', root));
      }).then(() => { creationCompleted = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(creationCompleted, false, 'agent creation waits for the ownership snapshot');
    });
    assert(creation);
    await creation;
    await projects.updateProject(project.id, { defaultAgentId: 'new-agent' });
    await persistence.saveConfig({
      integrations: {
        slack: { token: 'slack-test-token', mentionAgentId: 'new-agent' },
      },
    });
    const converged = await coordinator.reconcileAllDataIntegrity({
      reason: 'new owner preservation verification',
      includeStorage: false,
      includeExternalCleanup: false,
    });
    assert.equal(converged.integrationMentionAgentsDetached, 0);
    assert.equal(converged.projectDefaultAgentsDetached, 0);
    assert.equal((await persistence.loadConfig()).integrations.slack?.mentionAgentId, 'new-agent');
    assert.equal((await projects.getProject(project.id))?.defaultAgentId, 'new-agent');

    const idempotent = await coordinator.reconcileAllDataIntegrity({
      reason: 'cross-store ownership idempotence verification',
      includeStorage: false,
      includeExternalCleanup: false,
    });
    assert.equal(idempotent.integrationMentionAgentsDetached, 0);
    assert.equal(idempotent.projectDefaultAgentsDetached, 0);
    console.log('cross-store ownership verification passed');
  } finally {
    await coordinator.stopDataIntegritySchedule();
    db.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
