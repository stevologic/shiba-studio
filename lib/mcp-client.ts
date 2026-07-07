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

export async function connectMcpServer(
  server: McpServerRecord,
  timeoutMs = 30_000,
): Promise<McpClientHandle & { _client: InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client> }> {
  const { Client, StdioClientTransport } = await loadSdk();

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env } as Record<string, string>,
  });

  const client = new Client({ name: 'shiba-studio', version: '1.0.0' });

  const connectPromise = client.connect(transport);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`MCP connection timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  await Promise.race([connectPromise, timeout]);

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
      const result = await client.listTools();
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
    await handle.close();
  } catch {
    /* ignore */
  }
}

export async function invokeMcpTool(
  server: McpServerRecord,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let client: McpClientHandle | null = null;
  try {
    client = await connectMcpServer(server, 45_000);
    const result = await client.callTool(toolName, args);
    return { ok: true, result };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'MCP invoke failed' };
  } finally {
    if (client) await disconnectMcpClient(client);
  }
}