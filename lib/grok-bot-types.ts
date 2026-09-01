export interface GrokBotPublicStatus {
  enabled: boolean;
  hasToken: boolean;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string;
  publicOrigin: string;
  mcpUrl: string;
  loopbackMcpUrl: string;
  reachableFromXai: boolean;
}

export interface GrokBotSetup {
  instructions: string;
  mcp: {
    type: 'mcp';
    server_url: string;
    server_label: string;
    server_description: string;
    authorization: string;
  };
  plugin: {
    name: string;
    url: string;
    headers: { Authorization: string };
  };
  grokCliCommand: string;
  notes: string[];
}

export interface GrokBotToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface GrokBotToolResult {
  ok: boolean;
  action: string;
  detail: string;
  data?: Record<string, unknown>;
}
