/**
 * Inline chat tool approvals: Ask-before-act pauses gated tools, Always
 * approve remembers them, native desktop actions stay exact-click.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-chat-approvals-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '88'.repeat(32);

  const dbModule = await import('../lib/db');
  const approvals = await import('../lib/tool-approval');
  const persistence = await import('../lib/persistence');
  const { POST } = await import('../app/api/execute/approve/route');

  try {
    assert.equal(approvals.toolNeedsApproval('shell_exec', 'ask'), true);
    assert.equal(approvals.toolNeedsApproval('shell_exec', 'yolo'), false);
    assert.equal(approvals.toolNeedsApproval('shell_exec', 'ask', ['shell_exec']), false);
    assert.equal(approvals.toolNeedsApproval('native_node_action', 'yolo'), true);
    assert.equal(approvals.toolNeedsApproval('native_node_action', 'ask', ['native_node_action']), true);
    assert.equal(approvals.canAlwaysApproveTool('shell_exec'), true);
    assert.equal(approvals.canAlwaysApproveTool('native_node_action'), false);
    assert.deepEqual(
      approvals.sanitizeApprovedToolNames(['shell_exec', 'native_node_action', 'nope', 'shell_exec']),
      ['shell_exec'],
    );

    const waiter = approvals.beginToolApproval(
      'chat:session-1',
      'fs_write',
      { path: 'readme.md', content: 'hi' },
      5_000,
      { agentId: null, sessionId: 'session-1' },
    );
    const pending = approvals.getPendingApproval(waiter.approvalId);
    assert.equal(pending?.toolName, 'fs_write');
    assert.equal(pending?.sessionId, 'session-1');
    assert.equal(pending?.agentId, null);

    const alwaysRes = await POST(new NextRequest('http://localhost/api/execute/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: waiter.approvalId, always: true }),
    }));
    const alwaysBody = await alwaysRes.json();
    assert.equal(alwaysRes.status, 200);
    assert.equal(alwaysBody.ok, true);
    assert.equal(alwaysBody.approved, true);
    assert.equal(alwaysBody.always, true);
    assert.equal(await waiter.wait, true);
    const cfg = await persistence.loadConfig();
    assert.ok(cfg.alwaysApprovedTools?.includes('fs_write'), 'Grok Chat always-approve persists on config');

    const { normalizeAgent } = await import('../lib/types');
    const created = await persistence.mutateAgents((list) => {
      const now = new Date().toISOString();
      const agent = normalizeAgent({
        id: 'agent-approvals',
        name: 'Approval Agent',
        model: 'cloud:test',
        workspace: { path: process.cwd(), useWorktree: false },
        createdAt: now,
        updatedAt: now,
      });
      list.push(agent);
      return agent;
    });
    assert.equal(await approvals.rememberAlwaysApprovedTool('shell_exec', created.id), true);
    const remembered = (await persistence.loadAgents()).find((agent) => agent.id === created.id);
    assert.ok(remembered?.alwaysApprovedTools?.includes('shell_exec'));
    const merged = await approvals.loadAlwaysApprovedTools(created.id);
    assert.ok(merged.includes('shell_exec'));
    assert.ok(merged.includes('fs_write'), 'agent allowlist inherits Grok Chat always-approve');
    assert.equal(await approvals.rememberAlwaysApprovedTool('native_node_action', created.id), false);

    const nativeWaiter = approvals.beginToolApproval('run-native', 'native_node_action', { app: 'Notes' }, 2_000);
    const nativeRes = await POST(new NextRequest('http://localhost/api/execute/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: nativeWaiter.approvalId, always: true }),
    }));
    assert.equal(nativeRes.status, 400);
    approvals.resolveToolApproval(nativeWaiter.approvalId, false);

    const ac = new AbortController();
    ac.abort();
    assert.equal(await approvals.awaitLiveToolApproval({
      runId: 'chat:abort',
      toolName: 'x_post',
      args: { text: 'hi' },
      signal: ac.signal,
    }), false);

    const grokStream = await fs.readFile(path.join(ROOT, 'app/api/grok/stream/route.ts'), 'utf8');
    assert(grokStream.includes('approval_required'), 'chat stream emits approval_required');
    assert(grokStream.includes('requestChatToolApproval'), 'chat stream waits for live approval');
    assert(grokStream.includes('redditSubmitAuthorized: true'), 'approved Reddit posts are authorized');

    const panel = await fs.readFile(path.join(ROOT, 'components/grok-chat-panel.tsx'), 'utf8');
    assert(panel.includes('ToolApprovalCard'), 'agent chats render inline approval cards');
    assert(panel.includes('decideChatApproval'), 'chat can approve or always-approve');

    const card = await fs.readFile(path.join(ROOT, 'components/tool-approval-card.tsx'), 'utf8');
    assert(card.includes('Always approve'), 'Always approve is a visible action');
    assert(card.includes('Approve'), 'Approve is a visible action');
    assert(card.includes('Deny'), 'Deny remains available');

    console.log('CHAT_APPROVALS_OK inline=ask always=remember native=exact-click');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
