import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-phone-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '66'.repeat(32);
  delete process.env.SHIBA_PUBLIC_ORIGIN;
  delete process.env.SHIBA_LAN;
  delete process.env.SHIBA_LAN_STUDIO;
  delete process.env.SHIBA_LAN_PROXY_SECRET;

  const phone = await import('../lib/phone-assistant');
  const commands = await import('../lib/phone-commands');
  const mcp = await import('../lib/phone-mcp');
  const calls = await import('../lib/phone-call-session');
  const board = await import('../lib/board');
  const sessions = await import('../lib/chat-sessions');
  const adminRoute = await import('../app/api/phone/admin/route');
  const commandRoute = await import('../app/api/phone/command/route');
  const mcpRoute = await import('../app/api/phone/mcp/route');
  const incomingRoute = await import('../app/api/phone/incoming/route');
  const configRoute = await import('../app/api/config/route');
  const { proxy } = await import('../proxy');

  try {
    const disabled = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: 'create a task to leak without auth',
    }));
    assert.equal(disabled.status, 403, 'disabled phone assistant rejects commands');

    const remoteAdmin = await adminRoute.GET(new Request('http://shiba.local:3000/api/phone/admin'));
    assert.equal(remoteAdmin.status, 403, 'phone admin stays localhost-only');

    const statusRes = await adminRoute.GET(new Request('http://localhost:3000/api/phone/admin'));
    assert.equal(statusRes.status, 200);
    const initial = await statusRes.json() as { ok: boolean; status: { enabled: boolean; hasToken: boolean } };
    assert.equal(initial.status.enabled, false);
    assert.equal(initial.status.hasToken, false);

    const rotateRes = await adminRoute.POST(jsonRequest('http://localhost:3000/api/phone/admin', { action: 'rotate_token' }));
    assert.equal(rotateRes.status, 201);
    const rotated = await rotateRes.json() as {
      ok: boolean;
      token: string;
      status: { enabled: boolean; hasToken: boolean; tokenPrefix: string };
      setup: { mcp: { server_url: string; authorization: string }; instructions: string };
    };
    assert.match(rotated.token, /^shiba_phone_[A-Za-z0-9_-]{32,}$/);
    assert.equal(rotated.status.enabled, true);
    assert.equal(rotated.status.hasToken, true);
    assert.equal(rotated.setup.mcp.authorization, `Bearer ${rotated.token}`);
    assert.match(rotated.setup.instructions, /dictate_command/);
    const token = rotated.token;

    const cfg = await configRoute.GET();
    const cfgJson = await cfg.json() as {
      phoneAssistant?: { tokenHash?: string; webhookSecret?: string; hasToken?: boolean; enabled?: boolean };
    };
    assert.equal(cfgJson.phoneAssistant?.enabled, true);
    assert.equal(cfgJson.phoneAssistant?.hasToken, true);
    assert.equal(cfgJson.phoneAssistant?.tokenHash, undefined, 'config GET must not leak the token hash');
    assert.equal(cfgJson.phoneAssistant?.webhookSecret, undefined, 'config GET must not leak the webhook secret');
    const rawConfig = await fs.readFile(path.join(process.env.SHIBA_DATA_DIR!, 'config.json'), 'utf8');
    assert(!rawConfig.includes(token), 'raw phone token must never be stored');

    const denied = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: 'create a task to fix login',
    }, 'shiba_phone_this-token-is-not-valid-at-all-xx'));
    assert.equal(denied.status, 401);

    const created = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: 'create a task to ship the landing page',
    }, token));
    assert.equal(created.status, 200, 'spoken create-task must succeed on the shipped command route');
    const createdBody = await created.json() as {
      ok: boolean;
      result: { ok: boolean; action: string; data?: { key?: string; title?: string } };
    };
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.result.action, 'task');
    assert.match(String(createdBody.result.data?.key || ''), /^SHIB-/);
    assert.match(String(createdBody.result.data?.title || ''), /landing page/i);

    const cards = await board.listBoardTasks();
    assert.equal(cards.some((card) => card.id && card.title.toLowerCase().includes('landing page')), true, 'board store received the spoken card');

    const slash = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: '/task Review invoices | Check March totals',
    }, token));
    assert.equal(slash.status, 200);
    const slashBody = await slash.json() as { result: { data?: { title?: string } } };
    assert.equal(slashBody.result.data?.title, 'Review invoices');

    const listed = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: "what's on the board",
    }, token));
    const listedBody = await listed.json() as { result: { spoken: string } };
    assert.match(listedBody.result.spoken, /SHIB-/);
    assert.match(listedBody.result.spoken, /landing page/i);

    const remembered = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: 'remember that the deploy command is npm run deploy:prod',
    }, token));
    assert.equal(remembered.status, 200);
    const recalled = await commandRoute.POST(jsonRequest('http://localhost:3000/api/phone/command', {
      utterance: 'recall deploy',
    }, token));
    const recalledBody = await recalled.json() as { result: { spoken: string } };
    assert.match(recalledBody.result.spoken, /npm run deploy:prod/);

    const mapped = commands.resolveSpokenCommand('hey Shiba, create a task to fix the login bug');
    assert.ok(!('kind' in mapped) && mapped.name === 'task');
    assert.match(mapped.args, /login bug/i);

    const mcpInit = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/phone/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verifier', version: '1' } },
    }, token));
    assert.equal(mcpInit.status, 200);
    const initBody = await mcpInit.json() as { result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } };
    assert.equal(initBody.result?.serverInfo?.name, 'shiba-studio-phone');
    assert.ok(initBody.result?.capabilities?.tools);

    const listedTools = await mcp.handlePhoneMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolNames = ((listedTools?.result as { tools?: Array<{ name: string }> })?.tools || []).map((tool) => tool.name);
    assert(toolNames.includes('dictate_command'));
    assert(toolNames.includes('create_task'));

    const mcpCall = await mcpRoute.POST(jsonRequest('http://localhost:3000/api/phone/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_task', arguments: { title: 'MCP created card', description: 'from voice agent' } },
    }, token));
    assert.equal(mcpCall.status, 200);
    const mcpCallBody = await mcpCall.json() as { result?: { isError?: boolean; structuredContent?: { data?: { title?: string } } } };
    assert.equal(mcpCallBody.result?.isError, false);
    assert.equal(mcpCallBody.result?.structuredContent?.data?.title, 'MCP created card');
    assert.equal((await board.listBoardTasks()).some((card) => card.title === 'MCP created card'), true);

    const session = await sessions.getChatSession('phone-assistant');
    assert.ok(session, 'phone commands write a durable chat session');
    assert.equal(session?.title, 'Phone assistant');
    assert.ok((session?.messages || []).some((message) => /landing page/i.test(message.content)));

    const secret = `whsec_${Buffer.from('phone-webhook-secret-verifier').toString('base64')}`;
    await adminRoute.POST(jsonRequest('http://localhost:3000/api/phone/admin', {
      action: 'update',
      phoneNumber: '+15550100',
      webhookSecret: secret,
    }));
    const payload = JSON.stringify({
      type: 'realtime.call.incoming',
      data: {
        call_id: 'call_verify_12345678',
        sip_headers: [{ name: 'From', value: '+15550100' }, { name: 'To', value: '+18005550199' }],
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = 'evt_verify_1';
    const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
      .update(`${id}.${timestamp}.${payload}`)
      .digest('base64');
    const badIncoming = await incomingRoute.POST(new Request('http://localhost:3000/api/phone/incoming', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,not-the-right-signature`,
      },
      body: payload,
    }));
    assert.equal(badIncoming.status, 401);

    const parsed = calls.parseIncomingCall(JSON.parse(payload));
    assert.equal(parsed.callId, 'call_verify_12345678');
    phone.verifyStandardWebhookSignature({
      secret,
      id,
      timestamp,
      signature: `v1,${signature}`,
      rawBody: payload,
    });

    const toolResult = JSON.parse(await calls.handleRealtimeFunctionCall({
      name: 'create_task',
      arguments: JSON.stringify({ title: 'SIP function card' }),
    })) as { ok: boolean; data?: { title?: string } };
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.data?.title, 'SIP function card');

    process.env.SHIBA_LAN = '1';
    process.env.SHIBA_LAN_PROXY_SECRET = 'phone-verifier-lan-proxy-secret';
    const lanHeaders = (clientClass: 'local' | 'remote', extra: Record<string, string> = {}) => ({
      'x-shiba-client-class': clientClass,
      'x-shiba-lan-proxy-secret': process.env.SHIBA_LAN_PROXY_SECRET!,
      'x-forwarded-proto': 'http',
      host: 'shiba.local:3000',
      ...extra,
    });
    const blockedAdmin = proxy(new NextRequest('http://shiba.local:3000/api/phone/admin', {
      headers: lanHeaders('remote', { Origin: 'http://shiba.local:3000' }),
    }));
    assert.equal(blockedAdmin.status, 403, 'LAN remotes cannot administer the phone assistant');
    const missingPhoneBearer = proxy(new NextRequest('http://shiba.local:3000/api/phone/command', {
      method: 'POST',
      headers: lanHeaders('remote'),
    }));
    assert.equal(missingPhoneBearer.status, 401, 'proxy requires a shiba_phone_ bearer on the command path');
    const allowedIngress = proxy(new NextRequest('http://shiba.local:3000/api/phone/command', {
      method: 'POST',
      headers: lanHeaders('remote', { Authorization: `Bearer ${token}` }),
    }));
    assert.equal(allowedIngress.status, 200, 'LAN remotes may reach the signed phone command ingress');

    console.log('Phone assistant verification passed');
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
  console.error('Phone assistant verification failed', error);
  process.exitCode = 1;
});
