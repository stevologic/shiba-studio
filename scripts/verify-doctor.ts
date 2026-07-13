import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-doctor-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '66'.repeat(32);
  const doctor = await import('../lib/doctor');
  const persistence = await import('../lib/persistence');
  try {
    const preview = doctor.previewDoctorRepair('enable_safe_mode');
    assert.match(preview.effect, /optional listeners/i);
    await assert.rejects(
      doctor.applyDoctorRepair('enable_safe_mode', 'wrong'),
      /Exact confirmation/,
    );
    const applied = await doctor.applyDoctorRepair('enable_safe_mode', 'enable_safe_mode');
    assert.equal(applied.safeMode, true);
    assert.equal((await persistence.loadConfig()).safeMode, true);
    const mcp = await import('../lib/mcp');
    const mcpClient = await import('../lib/mcp-client');
    const configuredServer = await mcp.addCustomMcpServer({ name: 'Safe-mode verifier', command: 'node', args: ['server.js'], env: {} });
    const mcpStore = path.join(process.env.SHIBA_DATA_DIR!, 'mcp-servers.json');
    const storeBefore = await fs.stat(mcpStore);
    assert.deepEqual(await mcp.listEnabledMcpServers(), [], 'safe mode hides every enabled MCP server from agent discovery');
    await assert.rejects(() => mcpClient.connectMcpServer(configuredServer), /Safe mode disables MCP/);
    const report = await doctor.runDoctor();
    const storeAfter = await fs.stat(mcpStore);
    assert.equal(storeAfter.mtimeMs, storeBefore.mtimeMs, 'Doctor must not persist MCP maintenance while reading diagnostics');
    assert(report.checks.some((item) => item.id === 'sqlite-integrity' && item.status === 'ok'));
    assert(report.checks.some((item) => item.id === 'encryption-key'));
    assert(report.checks.some((item) => item.id === 'mcp-launch-readiness' && item.data?.processStarted === false));
    assert(report.checks.some((item) => item.id === 'browser-runtime' && typeof item.data?.launchHealthy === 'boolean'));
    assert(report.checks.some((item) => item.id === 'worktree-health'));
    assert(report.checks.some((item) => item.id === 'origin-firewall-boundary' && item.data?.originGuard === true));
    assert(report.checks.some((item) => item.id === 'host-firewall'));
    assert(report.checks.some((item) => item.id === 'extension-compatibility'));
    assert.equal(report.safeMode, true);
    const serialized = JSON.stringify(report);
    assert(!serialized.includes(process.env.SHIBA_SECRET_KEY!), 'Doctor report must not expose the encryption key');
    console.log('Doctor verification passed');
  } finally {
    const { closeDb } = await import('../lib/db');
    closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Doctor verification failed', error);
  process.exitCode = 1;
});
