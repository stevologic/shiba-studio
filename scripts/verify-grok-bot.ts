/**
 * Drives the shipped Grok Bot MCP admin + tools/call routes against real
 * Board, agent, and task-ledger stores. Does not re-implement the connector.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

function jsonRequest(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-grok-bot-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '66'.repeat(32);
  delete process.env.SHIBA_PUBLIC_ORIGIN;
  delete process.env.SHIBA_LAN;
  delete process.env.SHIBA_LAN_STUDIO;
  delete process.env.SHIBA_LAN_PROXY_SECRET;

  const grokBot = await import('../lib/grok-bot');
  const tools = await import('../lib/grok-bot-tools');
  const mcp = await import('../lib/grok-bot-mcp');
  const board = await import('../lib/board');
  const sessions = await import('../lib/chat-sessions');
  const ledger = await import('../lib/task-ledger');
  const persistence = await import('../lib/persistence');
  const { normalizeAgent } = await import('../lib/types');
  const adminRoute = await import('../app/api/grok-bot/admin/route');
  const mcpRoute = await import('../app/api/grok-bot/mcp/route');
  const configRoute = await import('../app/api/config/route');
  const { proxy } = await import('../proxy');

  try {
    const disabled = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }));
    assert.equal(disabled.status, 403, 'disabled Grok Bot connector rejects MCP');

    const remoteAdmin = await adminRoute.GET(new Request('http://shiba.local:3000/api/grok-bot/admin'));
    assert.equal(remoteAdmin.status, 403, 'Grok Bot admin stays localhost-only');

    const statusRes = await adminRoute.GET(new Request('http://localhost:3000/api/grok-bot/admin'));
    assert.equal(statusRes.status, 200);
    const initial = await statusRes.json() as { ok: boolean; status: { enabled: boolean; hasToken: boolean; loopbackMcpUrl: string } };
    assert.equal(initial.status.enabled, false);
    assert.equal(initial.status.hasToken, false);
    assert.match(initial.status.loopbackMcpUrl, /\/api\/grok-bot\/mcp$/);

    const rotateRes = await adminRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/admin', { action: 'rotate_token' }));
    assert.equal(rotateRes.status, 201);
    const rotated = await rotateRes.json() as {
      ok: boolean;
      token: string;
      status: { enabled: boolean; hasToken: boolean; tokenPrefix: string };
      setup: {
        mcp: { server_url: string; authorization: string; server_label: string };
        plugin: { url: string; headers: { Authorization: string } };
        grokCliCommand: string;
        instructions: string;
      };
    };
    assert.match(rotated.token, /^shiba_grokbot_[A-Za-z0-9_-]{32,}$/);
    assert.equal(rotated.status.enabled, true);
    assert.equal(rotated.status.hasToken, true);
    assert.equal(rotated.setup.mcp.authorization, `Bearer ${rotated.token}`);
    assert.equal(rotated.setup.plugin.headers.Authorization, `Bearer ${rotated.token}`);
    assert.match(rotated.setup.grokCliCommand, /grok mcp add --transport http shiba-studio/);
    assert.match(rotated.setup.instructions, /create_board_card/);
    const token = rotated.token;

    const cfg = await configRoute.GET();
    const cfgJson = await cfg.json() as {
      grokBot?: { tokenHash?: string; hasToken?: boolean; enabled?: boolean };
    };
    assert.equal(cfgJson.grokBot?.enabled, true);
    assert.equal(cfgJson.grokBot?.hasToken, true);
    assert.equal(cfgJson.grokBot?.tokenHash, undefined, 'config GET must not leak the Grok Bot token hash');
    const rawConfig = await fs.readFile(path.join(process.env.SHIBA_DATA_DIR!, 'config.json'), 'utf8');
    assert(!rawConfig.includes(token), 'raw Grok Bot token must never be stored');

    const denied = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }, 'shiba_grokbot_this-token-is-not-valid-at-all-xxxx'));
    assert.equal(denied.status, 401);

    await persistence.mutateAgents((agents) => {
      agents.push(normalizeAgent({
        id: 'grok-bot-verify-agent',
        name: 'Connector Relay',
        model: 'cloud:grok-4',
        description: 'Fixture agent for the Grok Bot connector test',
        workspace: { path: process.cwd(), useWorktree: false },
        integrations: {},
        peers: [],
        skills: [],
      }));
    });

    const mcpInit = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verifier', version: '1' } },
    }, token));
    assert.equal(mcpInit.status, 200);
    const initBody = await mcpInit.json() as { result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } };
    assert.equal(initBody.result?.serverInfo?.name, 'shiba-studio-grok-bot');
    assert.ok(initBody.result?.capabilities?.tools);

    const listedTools = await mcp.handleGrokBotMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const toolNames = ((listedTools?.result as { tools?: Array<{ name: string }> })?.tools || []).map((tool) => tool.name).sort();
    const shippedNames = tools.GROK_BOT_TOOLS.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, shippedNames, 'tools/list must expose the shipped Grok Bot tool catalog');
    for (const required of ['studio_status', 'list_agents', 'list_board', 'create_board_card', 'start_work', 'get_task', 'list_tasks', 'list_attention']) {
      assert(toolNames.includes(required), `missing ${required}`);
    }

    const createCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_board_card', arguments: { title: 'Grok Bot filed this card', description: 'from the MCP connector' } },
    }, token));
    assert.equal(createCall.status, 200, 'create_board_card must succeed on the shipped MCP route');
    const createBody = await createCall.json() as {
      result?: { isError?: boolean; structuredContent?: { ok?: boolean; data?: { key?: string; title?: string } } };
    };
    assert.equal(createBody.result?.isError, false);
    assert.equal(createBody.result?.structuredContent?.data?.title, 'Grok Bot filed this card');
    const createdKey = String(createBody.result?.structuredContent?.data?.key || '');
    assert.match(createdKey, /^SHIB-/);
    assert.equal(
      (await board.listBoardTasks()).some((card) => card.title === 'Grok Bot filed this card' && card.key === createdKey),
      true,
      'board store received the Grok Bot card',
    );

    const listBoardCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'list_board', arguments: { query: 'filed this card' } },
    }, token));
    const listBoardBody = await listBoardCall.json() as { result?: { structuredContent?: { detail?: string } } };
    assert.match(String(listBoardBody.result?.structuredContent?.detail || ''), /Grok Bot filed this card/);
    assert.match(String(listBoardBody.result?.structuredContent?.detail || ''), new RegExp(createdKey));

    const agentsCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'list_agents', arguments: {} },
    }, token));
    const agentsBody = await agentsCall.json() as {
      result?: { structuredContent?: { data?: { agents?: Array<{ id?: string; name?: string }> } } };
    };
    assert.equal(
      (agentsBody.result?.structuredContent?.data?.agents || []).some((agent) => agent.id === 'grok-bot-verify-agent' && agent.name === 'Connector Relay'),
      true,
      'list_agents must read the real agent store',
    );

    const startCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'start_work', arguments: { brief: 'Summarize the Grok Bot connector for the operator' } },
    }, token));
    assert.equal(startCall.status, 200);
    const startBody = await startCall.json() as {
      result?: { isError?: boolean; structuredContent?: { data?: { taskId?: string; kind?: string } } };
    };
    assert.equal(startBody.result?.isError, false);
    const taskId = String(startBody.result?.structuredContent?.data?.taskId || '');
    assert.match(taskId, /^grok-bot:/);
    const stored = ledger.getTask(taskId);
    assert.ok(stored, 'start_work must create a durable task ledger row');
    assert.match(stored.title, /Summarize the Grok Bot connector/);
    assert.equal(stored.metadata.grokBot, true);

    const getCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_task', arguments: { task_id: taskId } },
    }, token));
    const getBody = await getCall.json() as {
      result?: { structuredContent?: { data?: { id?: string; title?: string } } };
    };
    assert.equal(getBody.result?.structuredContent?.data?.id, taskId);
    assert.match(String(getBody.result?.structuredContent?.data?.title || ''), /Summarize the Grok Bot connector/);
    const liveTask = ledger.getTask(taskId);
    if (liveTask && !['succeeded', 'failed', 'cancelled', 'lost'].includes(liveTask.status)) {
      try {
        ledger.transitionTask({
          taskId,
          status: 'cancelled',
          expectedVersion: liveTask.version,
          error: 'verify-grok-bot finished',
        });
      } catch { /* run may have already terminalized */ }
    }

    const statusCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'studio_status', arguments: {} },
    }, token));
    const statusBody = await statusCall.json() as { result?: { structuredContent?: { detail?: string; data?: { agentCount?: number } } } };
    assert.match(String(statusBody.result?.structuredContent?.detail || ''), /Connector Relay|Agents: /);
    assert.equal(statusBody.result?.structuredContent?.data?.agentCount, 1);

    const attentionCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'list_attention', arguments: {} },
    }, token));
    const attentionBody = await attentionCall.json() as { result?: { isError?: boolean; structuredContent?: { ok?: boolean } } };
    assert.equal(attentionBody.result?.isError, false);
    assert.equal(attentionBody.result?.structuredContent?.ok, true);

    const unknownCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/grok-bot/mcp', {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'shell_exec', arguments: { command: 'rm -rf /' } },
    }, token));
    const unknownBody = await unknownCall.json() as { result?: { isError?: boolean } };
    assert.equal(unknownBody.result?.isError, true, 'unknown tools must fail closed');

    const sse = await mcpRoute.POST(new Request('http://localhost:3000/api/grok-bot/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'ping' }),
    }));
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(await sse.text(), /event: message/);

    const session = await sessions.getChatSession('grok-bot');
    assert.ok(session, 'Grok Bot tools write a durable chat session');
    assert.equal(session?.title, 'Grok Bot');
    assert.ok((session?.messages || []).some((message) => /Grok Bot filed this card/i.test(message.content)));

    const setup = grokBot.buildGrokBotSetup(await grokBot.getGrokBotStatus(), token);
    assert.equal(setup.mcp.type, 'mcp');
    assert.equal(setup.mcp.server_label, 'shiba-studio');

    process.env.SHIBA_LAN = '1';
    process.env.SHIBA_LAN_PROXY_SECRET = 'grok-bot-verifier-lan-proxy-secret';
    const lanHeaders = (clientClass: 'local' | 'remote', extra: Record<string, string> = {}) => ({
      'x-shiba-client-class': clientClass,
      'x-shiba-lan-proxy-secret': process.env.SHIBA_LAN_PROXY_SECRET!,
      'x-forwarded-proto': 'http',
      host: 'shiba.local:3000',
      ...extra,
    });
    const blockedAdmin = proxy(new NextRequest('http://shiba.local:3000/api/grok-bot/admin', {
      headers: lanHeaders('remote', { Origin: 'http://shiba.local:3000' }),
    }));
    assert.equal(blockedAdmin.status, 403, 'LAN remotes cannot administer the Grok Bot connector');
    const missingBearer = proxy(new NextRequest('http://shiba.local:3000/api/grok-bot/mcp', {
      method: 'POST',
      headers: lanHeaders('remote'),
    }));
    assert.equal(missingBearer.status, 401, 'proxy requires a shiba_grokbot_ bearer on the MCP path');
    const allowedIngress = proxy(new NextRequest('http://shiba.local:3000/api/grok-bot/mcp', {
      method: 'POST',
      headers: lanHeaders('remote', { Authorization: `Bearer ${token}` }),
    }));
    assert.equal(allowedIngress.status, 200, 'LAN remotes may reach the signed Grok Bot MCP ingress');

    console.log('Grok Bot connector verification passed');
  } finally {
    delete process.env.SHIBA_LAN;
    delete process.env.SHIBA_LAN_STUDIO;
    delete process.env.SHIBA_LAN_PROXY_SECRET;
    const { closeDb } = await import('../lib/db');
    closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Grok Bot connector verification failed', error);
  process.exitCode = 1;
});
