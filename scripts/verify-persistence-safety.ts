import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-persistence-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '11'.repeat(32);

  const mcp = await import('../lib/mcp');
  const usage = await import('../lib/usage');
  const integrations = await import('../lib/integrations');
  const workspace = await import('../lib/workspace');
  const projects = await import('../lib/projects');
  const backup = await import('../lib/backup');
  const persistence = await import('../lib/persistence');
  const { normalizeAgent } = await import('../lib/types');
  const database = await import('../lib/db');

  try {
    const xClientSecret = 'x-client-secret-regression';
    const x = await mcp.addMcpServerFromPreset('x', {}, {
      xClientId: 'x-client-id-regression',
      xClientSecret,
    });
    assert.equal(x.env.CLIENT_ID, 'x-client-id-regression');
    assert.equal(x.env.CLIENT_SECRET, xClientSecret);
    assert.equal(x.env.REDIRECT_URI, 'http://localhost:8080/callback');
    assert.deepEqual(x.args, ['-y', '@xdevplatform/xurl@1.2.2', 'mcp', 'https://api.x.com/mcp']);
    assert.match(x.env.HOME || '', /x-mcp[\\/]shiba-studio-[0-9a-f]{8}$/);
    assert.equal(x.env.USERPROFILE, x.env.HOME);
    assert.match(x.env.npm_config_cache || '', /npx-cache$/);

    await assert.rejects(
      mcp.addMcpServerFromPreset('x', { CLIENT_ID: 'different-client-id' }, {
        xClientId: 'x-client-id-regression',
        xClientSecret,
      }),
      /supplied together/,
      'a new X Client ID must never be paired with a previously saved secret',
    );

    const customSecret = 'custom-token-regression';
    await mcp.addCustomMcpServer({
      name: 'Secret test',
      command: 'node',
      env: { API_TOKEN: customSecret, PUBLIC_VALUE: 'visible' },
    });
    const mcpFile = path.join(process.env.SHIBA_DATA_DIR, 'mcp-servers.json');
    let raw = await fs.readFile(mcpFile, 'utf8');
    assert(!raw.includes(xClientSecret), 'X client secret must be encrypted at rest');
    assert(!raw.includes(customSecret), 'custom MCP tokens must be encrypted at rest');
    assert(!raw.includes('visible'), 'all custom MCP env values must be encrypted at rest');
    assert(raw.includes('enc:v1:'), 'encrypted MCP store should contain sealed values');

    const slackAppToken = 'xapp-slack-secret-regression';
    await persistence.saveConfig({
      integrations: { slack: { token: 'xoxb-slack-secret-regression', appToken: slackAppToken } },
    });
    const agent = normalizeAgent({
      id: 'secret-agent',
      name: 'Secret agent',
      model: 'local:test',
      workspace: { path: root, useWorktree: false },
      integrations: {},
      integrationOverrides: {
        slack: { token: 'xoxb-agent-secret-regression', appToken: slackAppToken },
      },
      peers: [],
      schedules: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await persistence.saveAgents([agent]);
    const configRaw = await fs.readFile(path.join(process.env.SHIBA_DATA_DIR, 'config.json'), 'utf8');
    const agentsRaw = await fs.readFile(path.join(process.env.SHIBA_DATA_DIR, 'agents.json'), 'utf8');
    assert(!configRaw.includes(slackAppToken), 'global Slack app token must be encrypted at rest');
    assert(!agentsRaw.includes(slackAppToken), 'agent Slack app token must be encrypted at rest');

    const legacySecret = 'legacy-plaintext-token';
    await fs.writeFile(mcpFile, JSON.stringify({
      servers: [{
        id: 'legacy',
        name: 'Legacy',
        enabled: true,
        command: 'node',
        args: [],
        env: { API_TOKEN: legacySecret },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
    }));
    const migrated = await mcp.listMcpServers();
    assert.equal(migrated[0]?.env.API_TOKEN, legacySecret);
    raw = await fs.readFile(mcpFile, 'utf8');
    assert(!raw.includes(legacySecret), 'legacy plaintext MCP tokens should migrate on read');

    const concurrentServers = 16;
    await Promise.all(Array.from({ length: concurrentServers }, (_, i) => mcp.addCustomMcpServer({
      name: `Concurrent ${i}`,
      command: 'node',
      env: { API_KEY: `key-${i}` },
    })));
    assert.equal((await mcp.listMcpServers()).length, concurrentServers + 1);

    const concurrentUsage = 64;
    await Promise.all(Array.from({ length: concurrentUsage }, (_, i) => usage.recordUsage({
      model: 'grok-4.3',
      source: 'other',
      sourceId: `usage-${i}`,
      usage: { prompt_tokens: i + 1, completion_tokens: 1, total_tokens: i + 2 },
    })));
    const usageRecords = await usage.loadUsageRecords();
    assert.equal(usageRecords.length, concurrentUsage, 'concurrent usage writes must not be lost');
    assert.equal(new Set(usageRecords.map((record) => record.sourceId)).size, concurrentUsage);

    const scoped = await Promise.all([
      integrations.withIntegrationCreds({ github: { token: 'account-a' } }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return integrations.getIntegrationCreds().github?.token;
      }),
      integrations.withIntegrationCreds({ github: { token: 'account-b' } }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return integrations.getIntegrationCreds().github?.token;
      }),
    ]);
    assert.deepEqual(scoped, ['account-a', 'account-b'], 'integration credentials must remain request-scoped');

    integrations.setIntegrationCreds({
      googledrive: { accessToken: 'global-drive-token', refreshToken: 'global-drive-refresh' },
    });
    const scopedDrive = integrations.mergeAgentIntegrationCreds(
      integrations.getIntegrationCreds(),
      { googledrive: { accessToken: 'agent-drive-token' } },
    );
    const driveAuth = await integrations.withIntegrationCreds(scopedDrive, () => integrations.driveAuth()) as {
      credentials?: { access_token?: string };
    };
    assert.equal(
      driveAuth.credentials?.access_token,
      'agent-drive-token',
      'agent Drive access token must win over the global OAuth refresh session',
    );

    await assert.rejects(
      workspace.ensureWorktree(root, '../escape', 'main'),
      /Invalid agent id|escapes/,
      'worktree IDs must not escape the workspace',
    );
    await assert.rejects(workspace.ensureWorktree(root, 'NUL', 'main'), /Invalid agent id/);
    await assert.rejects(projects.deleteProject('../../victim'), /Project not found|Invalid project id/);
    await assert.rejects(
      projects.readProjectFileText('safe-project', '../../victim'),
      /Invalid stored project filename|escapes/,
      'persisted project filenames must not escape project-files',
    );
    await assert.rejects(projects.readProjectFileText('safe-project', 'NUL'), /Invalid stored project filename/);

    const liveDb = database.getDb();
    liveDb.exec('CREATE TABLE IF NOT EXISTS restore_sentinel (value TEXT); DELETE FROM restore_sentinel; INSERT INTO restore_sentinel VALUES (\'kept\')');
    const invalidSchemaPath = path.join(root, 'valid-sqlite-invalid-schema.db');
    const sqlite = process.getBuiltinModule?.('node:sqlite') as {
      DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void };
    } | undefined;
    assert(sqlite, 'node:sqlite is required for restore rollback verification');
    const invalidSchema = new sqlite.DatabaseSync(invalidSchemaPath);
    invalidSchema.exec('CREATE TABLE runs_fts (bad TEXT); PRAGMA user_version = 1');
    invalidSchema.close();
    const rollbackRestore = await backup.restoreBackup({
      format: backup.BACKUP_FORMAT,
      version: backup.BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      stores: {},
      sqliteBase64: (await fs.readFile(invalidSchemaPath)).toString('base64'),
    });
    assert.match(rollbackRestore.warnings.join('\n'), /previous database restored and reopened/);
    const sentinel = database.getDb().prepare('SELECT value FROM restore_sentinel').get() as { value?: string };
    assert.equal(sentinel.value, 'kept', 'failed SQLite restore must put the previous live database back');

    const shellAbort = new AbortController();
    const shellStarted = Date.now();
    setTimeout(() => shellAbort.abort(new Error('verification abort')), 75);
    const shellResult = await workspace.shellExec(
      process.platform === 'win32' ? 'set /p SHIBA_WAIT=' : 'read SHIBA_WAIT',
      root,
      10_000,
      shellAbort.signal,
    );
    assert.equal(shellResult.code, -1, 'aborted shell commands should report the cancellation');
    assert(Date.now() - shellStarted < 2_000, 'aborted shell commands must be terminated promptly');

    const configPath = path.join(process.env.SHIBA_DATA_DIR, 'config.json');
    const configBeforeRejectedRestore = await fs.readFile(configPath, 'utf8');
    const rejectedRestore = await backup.restoreBackup({
      format: backup.BACKUP_FORMAT,
      version: backup.BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      stores: { 'config.json': JSON.stringify({ sentinel: 'must-not-write' }) },
      sqliteBase64: null,
      secretKeyHex: '22'.repeat(32),
    });
    assert.equal(rejectedRestore.ok, false);
    assert.match(rejectedRestore.error || '', /different|key/i);
    assert.equal(
      await fs.readFile(configPath, 'utf8'),
      configBeforeRejectedRestore,
      'a mismatched restore key must not modify existing config',
    );

    console.log('Persistence and isolation verification passed');
  } finally {
    (await import('../lib/db')).closeDb();
    // Windows can release SQLite/child-process handles one tick after close.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EBUSY' || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
}

main().catch((error) => {
  console.error('Persistence and isolation verification failed', error);
  process.exit(1);
});
