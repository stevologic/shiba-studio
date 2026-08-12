/**
 * Optional SIP ingress: xAI posts realtime.call.incoming, Studio joins the
 * Speech-to-Speech session and answers function calls with the same executor
 * the MCP path uses. Voice Agent Builder does not need this.
 */

import WebSocket from 'ws';
import {
  callerAllowed,
  loadPhoneWebhookSecret,
  PhoneAssistantError,
  verifyStandardWebhookSignature,
} from './phone-assistant';
import { executePhoneTool, PHONE_TOOLS } from './phone-commands';
import { loadConfig } from './persistence';
import { resolveCloudBearer } from './xai-oauth';

export interface IncomingCallEvent {
  type?: string;
  data?: {
    call_id?: string;
    sip_headers?: Array<{ name?: string; value?: string }>;
  };
}

const activeCalls = new Map<string, { startedAt: number; from: string }>();

export function phoneFunctionTools(): Array<Record<string, unknown>> {
  return PHONE_TOOLS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function phoneCallInstructions(): string {
  return [
    'You are the Shiba Studio phone assistant. The caller is the studio owner.',
    'When they dictate work, call dictate_command with their exact request.',
    'Confirm what you did in one short spoken sentence using only tool results.',
  ].join(' ');
}

export function sipHeader(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  const needle = name.toLowerCase();
  return (headers || []).find((header) => String(header.name || '').toLowerCase() === needle)?.value || '';
}

export function parseIncomingCall(payload: unknown): { callId: string; from: string; to: string } {
  const event = (payload && typeof payload === 'object' ? payload : {}) as IncomingCallEvent;
  if (event.type && event.type !== 'realtime.call.incoming') {
    throw new PhoneAssistantError(`Unsupported incoming event: ${event.type}`, 400);
  }
  const callId = String(event.data?.call_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(callId)) {
    throw new PhoneAssistantError('Incoming call is missing a valid call_id', 400);
  }
  return {
    callId,
    from: sipHeader(event.data?.sip_headers, 'From'),
    to: sipHeader(event.data?.sip_headers, 'To'),
  };
}

export async function verifyIncomingPhoneWebhook(input: {
  id: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}): Promise<void> {
  const secret = await loadPhoneWebhookSecret();
  verifyStandardWebhookSignature({ ...input, secret });
}

export async function authorizeIncomingCaller(fromHeader: string): Promise<void> {
  const allowed = (await loadConfig()).phoneAssistant?.allowedCallers || [];
  if (!callerAllowed(fromHeader, allowed)) {
    throw new PhoneAssistantError('This caller is not on the phone assistant allowlist', 403);
  }
}

export async function handleRealtimeFunctionCall(event: {
  name?: string;
  arguments?: string;
}): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = event.arguments ? JSON.parse(event.arguments) as Record<string, unknown> : {}; }
  catch { args = {}; }
  const result = await executePhoneTool(String(event.name || ''), args);
  return JSON.stringify(result);
}

export function activePhoneCalls(): Array<{ callId: string; startedAt: number; from: string }> {
  return [...activeCalls.entries()].map(([callId, value]) => ({ callId, ...value }));
}

export async function joinPhoneCall(callId: string, from = ''): Promise<void> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.hasCloudAuth || !auth.token) {
    throw new PhoneAssistantError('An xAI cloud credential is required to join a phone call', 503);
  }
  const url = `wss://api.x.ai/v1/realtime?call_id=${encodeURIComponent(callId)}`;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${auth.token}` } });
    const pending = new Map<string, Promise<void>>();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      activeCalls.delete(callId);
      reject(error);
    };
    ws.once('open', () => {
      activeCalls.set(callId, { startedAt: Date.now(), from });
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          voice: cfg.defaultTtsVoice || 'eve',
          instructions: phoneCallInstructions(),
          turn_detection: { type: 'server_vad' },
          tools: phoneFunctionTools(),
        },
      }));
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'force_message',
          role: 'assistant',
          interruptible: true,
          content: [{ type: 'output_text', text: 'Shiba Studio here. What should I do?' }],
        },
      }));
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    ws.on('message', (raw) => {
      let event: { type?: string; name?: string; call_id?: string; arguments?: string };
      try { event = JSON.parse(String(raw)) as typeof event; }
      catch { return; }
      if (event.type !== 'response.function_call_arguments.done' || !event.call_id) return;
      const callKey = event.call_id;
      const work = handleRealtimeFunctionCall(event).then((output) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callKey, output },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      }).catch((error) => {
        console.error('[phone-assistant] function call failed', error);
      }).finally(() => {
        pending.delete(callKey);
      });
      pending.set(callKey, work);
    });
    ws.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    ws.once('close', () => {
      activeCalls.delete(callId);
      if (!settled) fail(new Error('Phone call websocket closed before session.update'));
    });
  });
}

export async function acceptIncomingPhoneCall(payload: unknown): Promise<{ callId: string; from: string; accepted: boolean }> {
  const parsed = parseIncomingCall(payload);
  await authorizeIncomingCaller(parsed.from);
  void joinPhoneCall(parsed.callId, parsed.from).catch((error) => {
    console.error('[phone-assistant] failed to join incoming call', parsed.callId, error);
  });
  return { callId: parsed.callId, from: parsed.from, accepted: true };
}
