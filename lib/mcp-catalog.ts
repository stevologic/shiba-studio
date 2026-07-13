/** Curated one-click MCP server presets for Shiba Studio. */

export interface McpPresetEnvField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  /** When set, value is appended to args instead of env (e.g. filesystem path). */
  asArg?: boolean;
  help?: string;
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
  /** npm package or binary name shown in the UI */
  packageName?: string;
  /** Group chip: web, code, files, security, search */
  category?: string;
  /**
   * Public documentation URL (npm, GitHub, or product docs).
   * When set, the Capabilities UI shows a “Docs” link.
   */
  docsUrl?: string;
  /** Optional secondary link (e.g. MCP protocol or package page). */
  homepageUrl?: string;
  /** One-line “what agents get” for the card. */
  toolsHint?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    shortLabel: 'GitHub',
    description: 'Repos, issues, pull requests, and code search on GitHub',
    icon: '/integrations/github.svg',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    packageName: '@modelcontextprotocol/server-github',
    category: 'Code',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    homepageUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-github',
    toolsHint: 'Issues, PRs, search, file contents',
    envFields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        placeholder: 'ghp_…',
        secret: true,
        required: true,
        help: 'Classic or fine-grained PAT with repo access. Create under GitHub → Settings → Developer settings.',
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
    packageName: '@cyanheads/osv-advisory-mcp-server',
    category: 'Security',
    docsUrl: 'https://github.com/cyanheads/osv-advisory-mcp-server',
    homepageUrl: 'https://www.npmjs.com/package/@cyanheads/osv-advisory-mcp-server',
    toolsHint: 'Package vulnerability queries',
    envFields: [],
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    shortLabel: 'Fetch',
    description: 'Fetch URLs and convert pages to markdown, text, or JSON for agents',
    icon: '/integrations/mcp-globe.svg',
    command: 'npx',
    // The official fetch server is Python-only (uvx mcp-server-fetch); this is
    // the maintained npm equivalent, exposing fetch_html/markdown/txt/json.
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    packageName: '@tokenizin/mcp-npx-fetch',
    category: 'Web',
    docsUrl: 'https://www.npmjs.com/package/@tokenizin/mcp-npx-fetch',
    homepageUrl: 'https://github.com/tokenizin-agency/mcp-npx-fetch',
    toolsHint: 'fetch_html, fetch_markdown, fetch_txt, fetch_json',
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
    packageName: '@modelcontextprotocol/server-filesystem',
    category: 'Files',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    homepageUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
    toolsHint: 'Read, list, and search within a sandbox path',
    envFields: [
      {
        key: 'allowedPath',
        label: 'Allowed directory',
        placeholder: 'C:\\Users\\you\\Projects\\my-repo',
        required: true,
        asArg: true,
        help: 'Agents can only access files under this path. Prefer a project root or workspace.',
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
    packageName: '@modelcontextprotocol/server-brave-search',
    category: 'Search',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    homepageUrl: 'https://brave.com/search/api/',
    toolsHint: 'brave_web_search, brave_local_search',
    envFields: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API Key',
        placeholder: 'BSA…',
        secret: true,
        required: true,
        help: 'Get a key from the Brave Search API dashboard.',
      },
    ],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    shortLabel: 'X',
    description: 'Post, read, search, and analyze on X through the official X API MCP bridge. Signs in with X via OAuth 2.0 in the browser (like the providers) — you supply your X app\'s Client ID/Secret once, then it caches and refreshes the token.',
    icon: '/integrations/x.svg',
    command: 'npx',
    // xurl is X's official CLI; its `mcp` subcommand bridges stdio to X's
    // hosted MCP endpoint. No separate install — npx fetches it on first run.
    args: ['-y', '@xdevplatform/xurl@1.2.2', 'mcp', 'https://api.x.com/mcp'],
    packageName: '@xdevplatform/xurl@1.2.2',
    category: 'Social',
    docsUrl: 'https://docs.x.com/tools/mcp',
    homepageUrl: 'https://github.com/xdevplatform/xurl',
    toolsHint: 'Post & read posts, search, timelines, user lookups',
    envFields: [
      {
        key: 'CLIENT_ID',
        label: 'X App Client ID',
        placeholder: 'OAuth 2.0 Client ID',
        required: true,
        help: 'X requires your own app (there is no shared/default X MCP client), so this Client ID is needed — it is NOT the same as the OAuth 1.0a keys used by the built-in x_post tool, nor the xAI "Sign in with X". Get it at developer.x.com → your app → OAuth 2.0. The MCP then signs in via the browser (OAuth 2.0 PKCE) and caches/refreshes the token itself.',
      },
      {
        key: 'CLIENT_SECRET',
        label: 'X App Client Secret',
        placeholder: 'OAuth 2.0 Client Secret',
        secret: true,
        required: true,
        help: 'OAuth 2.0 client secret for the same X app.',
      },
    ],
  },
];

/** Protocol-level docs (always public). */
export const MCP_PROTOCOL_DOCS_URL = 'https://modelcontextprotocol.io/docs';
export const MCP_SERVERS_REGISTRY_URL = 'https://github.com/modelcontextprotocol/servers';

const byId = new Map(MCP_PRESETS.map((p) => [p.id, p]));

/** Stable, non-secret profile name used to isolate xurl's credential home. */
export function xurlCredentialProfile(clientId: string): string {
  let hash = 0x811c9dc5;
  for (const char of clientId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `shiba-studio-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function getMcpPreset(id: string): McpPreset | undefined {
  return byId.get(id);
}

export function buildServerFromPreset(
  presetId: string,
  fieldValues: Record<string, string>,
  defaults?: {
    workspacePath?: string;
    githubToken?: string;
    xClientId?: string;
    xClientSecret?: string;
  },
): { name: string; command: string; args: string[]; env: Record<string, string> } | null {
  const preset = getMcpPreset(presetId);
  if (!preset) return null;

  const env: Record<string, string> = {};
  const args = [...preset.args];

  // X app credentials are a pair. The UI intentionally pre-fills the saved
  // Client ID without returning the saved secret to the browser, so that exact
  // ID may reuse the complete server-side pair. A different ID must arrive
  // with its matching secret instead of being combined with an old one.
  let resolvedXClientId = '';
  let resolvedXClientSecret = '';
  if (presetId === 'x') {
    const submittedId = fieldValues.CLIENT_ID?.trim() || '';
    const submittedSecret = fieldValues.CLIENT_SECRET?.trim() || '';
    const savedId = defaults?.xClientId?.trim() || '';
    const savedSecret = defaults?.xClientSecret?.trim() || '';

    if (submittedId && submittedSecret) {
      resolvedXClientId = submittedId;
      resolvedXClientSecret = submittedSecret;
    } else if (submittedId && savedId === submittedId && savedSecret) {
      resolvedXClientId = savedId;
      resolvedXClientSecret = savedSecret;
    } else if (!submittedId && !submittedSecret && savedId && savedSecret) {
      resolvedXClientId = savedId;
      resolvedXClientSecret = savedSecret;
    } else if (submittedId || submittedSecret) {
      throw new Error('X App Client ID and Client Secret must be supplied together');
    } else if (savedId || savedSecret) {
      throw new Error('The saved X OAuth 2.0 app credentials are incomplete; save both Client ID and Client Secret');
    }
  }

  for (const field of preset.envFields) {
    let value = fieldValues[field.key]?.trim() || '';
    if (!value && field.key === 'GITHUB_PERSONAL_ACCESS_TOKEN' && defaults?.githubToken) {
      value = defaults.githubToken;
    }
    if (!value && field.asArg && field.key === 'allowedPath' && defaults?.workspacePath) {
      value = defaults.workspacePath;
    }
    if (presetId === 'x' && field.key === 'CLIENT_ID') value = resolvedXClientId;
    if (presetId === 'x' && field.key === 'CLIENT_SECRET') value = resolvedXClientSecret;
    if (field.required && !value) {
      throw new Error(`${field.label} is required`);
    }
    if (field.asArg && value) {
      args.push(value);
    } else if (value) {
      env[field.key] = value;
    }
  }

  if (presetId === 'x' && env.CLIENT_ID) {
    env.REDIRECT_URI = 'http://localhost:8080/callback';
  }

  return {
    name: preset.name,
    command: preset.command,
    args,
    env,
  };
}
