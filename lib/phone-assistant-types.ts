export interface PhoneAssistantPublicStatus {
  enabled: boolean;
  hasToken: boolean;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string;
  phoneNumber: string;
  hasWebhookSecret: boolean;
  allowedCallers: string[];
  publicOrigin: string;
  mcpUrl: string;
  commandUrl: string;
  incomingUrl: string;
  voiceBuilderUrl: string;
  reachableFromXai: boolean;
}

export interface PhoneAssistantSetup {
  instructions: string;
  mcp: {
    type: 'mcp';
    server_url: string;
    server_label: string;
    server_description: string;
    authorization: string;
  };
  functionTool: {
    type: 'function';
    name: 'dictate_command';
    description: string;
    parameters: {
      type: 'object';
      properties: { utterance: { type: 'string'; description: string } };
      required: ['utterance'];
    };
  };
}
