/** Curated one-click MCP server presets for Shiba Studio. */

export interface McpPresetEnvField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  /** When set, value is appended to args instead of env (e.g. filesystem path). */
  asArg?: boolean;
}

export interface McpPreset {
  id: string;
  name: string;
  shortLabel: string;
  description: string;
  icon: string;
  command: string;
  args: string[];
  envFields: McpPresetEnvField[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    shortLabel: 'GitHub',
    description: 'Repos, issues, pull requests, and code search',
    icon: '/integrations/github.svg',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envFields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        placeholder: 'ghp_…',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'osv-advisory',
    name: 'OSV Advisory',
    shortLabel: 'OSV',
    description: 'CVE and open-source vulnerability database lookups',
    icon: '/integrations/mcp-shield.svg',
    command: 'npx',
    args: ['-y', '@cyanheads/osv-advisory-mcp-server'],
    envFields: [],
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    shortLabel: 'Fetch',
    description: 'Fetch URLs and convert pages to markdown/text/JSON for agents',
    icon: '/integrations/mcp-globe.svg',
    command: 'npx',
    // The official fetch server is Python-only (uvx mcp-server-fetch); this is
    // the maintained npm equivalent, exposing fetch_html/markdown/txt/json.
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    envFields: [],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    shortLabel: 'Files',
    description: 'Read and search files in an allowed workspace directory',
    icon: '/integrations/mcp-folder.svg',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envFields: [
      {
        key: 'allowedPath',
        label: 'Allowed directory',
        placeholder: 'C:\\Users\\you\\Projects\\my-repo',
        required: true,
        asArg: true,
      },
    ],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    shortLabel: 'Search',
    description: 'Web search via the Brave Search API',
    icon: '/integrations/mcp-search.svg',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envFields: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API Key',
        placeholder: 'BSA…',
        secret: true,
        required: true,
      },
    ],
  },
];

const byId = new Map(MCP_PRESETS.map((p) => [p.id, p]));

export function getMcpPreset(id: string): McpPreset | undefined {
  return byId.get(id);
}

export function buildServerFromPreset(
  presetId: string,
  fieldValues: Record<string, string>,
  defaults?: { workspacePath?: string; githubToken?: string },
): { name: string; command: string; args: string[]; env: Record<string, string> } | null {
  const preset = getMcpPreset(presetId);
  if (!preset) return null;

  const env: Record<string, string> = {};
  const args = [...preset.args];

  for (const field of preset.envFields) {
    let value = fieldValues[field.key]?.trim() || '';
    if (!value && field.key === 'GITHUB_PERSONAL_ACCESS_TOKEN' && defaults?.githubToken) {
      value = defaults.githubToken;
    }
    if (!value && field.asArg && field.key === 'allowedPath' && defaults?.workspacePath) {
      value = defaults.workspacePath;
    }
    if (field.required && !value) {
      throw new Error(`${field.label} is required`);
    }
    if (field.asArg && value) {
      args.push(value);
    } else if (value) {
      env[field.key] = value;
    }
  }

  return {
    name: preset.name,
    command: preset.command,
    args,
    env,
  };
}