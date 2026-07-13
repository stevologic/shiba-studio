import type { McpServerRecord } from './mcp';

type McpClientHandle = {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string }> }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  getServerVersion?: () => string;
  close: () => Promise<void>;
};

let ClientClass: typeof import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
let StdioTransportClass: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport | null = null;

async function loadSdk() {
  if (!ClientClass || !StdioTransportClass) {
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
    ClientClass = clientMod.Client;
    StdioTransportClass = stdioMod.StdioClientTransport;
  }
  return { Client: ClientClass!, StdioClientTransport: StdioTransportClass! };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
  }
  try {
    const candidates: Promise<T>[] = [
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timeoutId.unref?.();
      }),
    ];
    if (signal) {
      candidates.push(new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`));
        signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    return await Promise.race(candidates);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** True for servers that do a one-time interactive OAuth sign-in on first run
 *  (e.g. the X MCP via xurl, which opens a browser and holds the MCP handshake
 *  open until you finish signing in). These need a much longer connect budget. */
function needsInteractiveOAuth(server: McpServerRecord): boolean {
  const hay = `${server.command} ${(server.args || []).join(' ')}`.toLowerCase();
  return hay.includes('xurl');
}

export async function connectMcpServer(
  server: McpServerRecord,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<McpClientHandle & { _client: InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client> }> {
  const { Client, StdioClientTransport } = await loadSdk();

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env } as Record<string, string>,
  });

  const client = new Client({ name: 'shiba-studio', version: '1.0.0' });

  // A first-run OAuth login (browser sign-in) can take a couple of minutes; the
  // MCP handshake is held until it completes, so don't cut it off at 30s.
  const effectiveTimeout = needsInteractiveOAuth(server) ? Math.max(timeoutMs, 300_000) : timeoutMs;
  try {
    await withTimeout(client.connect(transport), effectiveTimeout, 'MCP connection', signal);
  } catch (error) {
    await withTimeout(client.close(), 10_000, 'MCP cleanup').catch(() => {});
    throw error;
  }

  let serverVersion = '';
  try {
    const init = await client.getServerVersion();
    serverVersion = init ? `${init.name} ${init.version}` : '';
  } catch {
    /* optional */
  }

  return {
    _client: client,
    getServerVersion: () => serverVersion,
    async listTools() {
      const result = await withTimeout(client.listTools(), 45_000, 'MCP tool listing', signal);
      return { tools: result.tools || [] };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return result;
    },
    async close() {
      await client.close();
    },
  };
}

export async function disconnectMcpClient(handle: McpClientHandle): Promise<void> {
  try {
    await withTimeout(handle.close(), 10_000, 'MCP disconnect');
  } catch {
    /* ignore */
  }
}

export async function invokeMcpTool(
  server: McpServerRecord,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let client: McpClientHandle | null = null;
  try {
    client = await connectMcpServer(server, 45_000, signal);
    const result = await withTimeout(
      client.callTool(toolName, args),
      120_000,
      `MCP tool "${toolName}"`,
      signal,
    );
    return { ok: true, result };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'MCP invoke failed' };
  } finally {
    if (client) await disconnectMcpClient(client);
  }
}
