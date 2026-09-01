/**
 * Streamable HTTP MCP surface for Grok Bot, grok.com connectors, and
 * `grok mcp add --transport http`. xAI or the desktop Bot connects with
 * Bearer auth; tools run in-process against the Studio stores.
 */

import { executeGrokBotTool, GROK_BOT_TOOLS } from './grok-bot-tools';
import type { GrokBotToolResult } from './grok-bot-types';

const PROTOCOL = '2025-03-26';
const SERVER_INFO = { name: 'shiba-studio-grok-bot', version: '0.2.0' };

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolText(result: GrokBotToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  structuredContent: GrokBotToolResult;
} {
  return {
    content: [{ type: 'text', text: result.detail }],
    isError: !result.ok,
    structuredContent: result,
  };
}

export async function handleGrokBotMcpMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = message.id === undefined ? null : message.id;
  const method = String(message.method || '');
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Use studio_status, list_board, list_agents, list_tasks, list_attention, create_board_card, start_work, and get_task. Report only tool output.',
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: GROK_BOT_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }
  if (method === 'tools/call') {
    const params = asObject(message.params);
    const name = String(params.name || '').trim();
    if (!name) return rpcError(id, -32602, 'tools/call requires a tool name');
    const args = asObject(params.arguments);
    const result = await executeGrokBotTool(name, args);
    return rpcResult(id, toolText(result));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleGrokBotMcpPayload(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const out: JsonRpcResponse[] = [];
    for (const item of payload) {
      const message = item && typeof item === 'object' ? item as JsonRpcRequest : {};
      const response = await handleGrokBotMcpMessage(message);
      if (response) out.push(response);
    }
    return out.length ? out : null;
  }
  if (!payload || typeof payload !== 'object') {
    return rpcError(null, -32600, 'Invalid JSON-RPC payload');
  }
  return handleGrokBotMcpMessage(payload as JsonRpcRequest);
}

export function encodeGrokBotMcpSse(body: JsonRpcResponse | JsonRpcResponse[]): string {
  const frames = Array.isArray(body) ? body : [body];
  return frames.map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
