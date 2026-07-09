/** UI catalog for Shiba Studio integrations. */

export type IntegrationId = 'github' | 'slack' | 'googledrive' | 'discord' | 'x' | 'obsidian' | 'vercel' | 'netlify';

export interface IntegrationMeta {
  id: IntegrationId;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
  /**
   * Official API / product docs for credential setup and endpoints.
   * Shown on the Capabilities page as an external “API docs” link.
   */
  docsUrl?: string;
  /** Optional secondary setup guide (e.g. OAuth app creation). */
  setupUrl?: string;
  docsLabel?: string;
}

export const INTEGRATION_CATALOG: IntegrationMeta[] = [
  {
    id: 'github',
    label: 'GitHub',
    shortLabel: 'GitHub',
    icon: '/integrations/github.svg',
    description: 'Repos, commits, and pull requests',
    docsUrl: 'https://docs.github.com/en/rest',
    setupUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    docsLabel: 'GitHub REST API',
  },
  {
    id: 'slack',
    label: 'Slack',
    shortLabel: 'Slack',
    icon: '/integrations/slack.svg',
    description: 'Post messages and reply to @mentions',
    docsUrl: 'https://api.slack.com/docs',
    setupUrl: 'https://api.slack.com/apis/connections/socket',
    docsLabel: 'Slack API',
  },
  {
    id: 'googledrive',
    label: 'Google Drive',
    shortLabel: 'Drive',
    icon: '/integrations/googledrive.svg',
    description: 'Read and write Drive files',
    docsUrl: 'https://developers.google.com/drive/api/guides/about-sdk',
    setupUrl: 'https://developers.google.com/drive/api/guides/enable-drive-api',
    docsLabel: 'Drive API',
  },
  {
    id: 'discord',
    label: 'Discord',
    shortLabel: 'Discord',
    icon: '/integrations/discord.svg',
    description: 'Post messages and reply to @mentions',
    docsUrl: 'https://discord.com/developers/docs/intro',
    setupUrl: 'https://discord.com/developers/docs/topics/gateway',
    docsLabel: 'Discord API',
  },
  {
    id: 'x',
    label: 'X',
    shortLabel: 'X',
    icon: '/integrations/x.svg',
    description: 'Post tweets to your X account',
    docsUrl: 'https://docs.x.com/x-api/introduction',
    setupUrl: 'https://docs.x.com/resources/fundamentals/authentication/overview',
    docsLabel: 'X API',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    shortLabel: 'Obsidian',
    icon: '/integrations/obsidian.svg',
    description: 'Read, write, and search notes in your vault',
    // Local vault has no public API; cloud mode uses the community REST plugin.
    docsUrl: 'https://coddingtonbear.github.io/obsidian-local-rest-api/',
    setupUrl: 'https://help.obsidian.md/',
    docsLabel: 'Local REST API',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    shortLabel: 'Vercel',
    icon: '/integrations/vercel.svg',
    description: 'Deploy apps, list projects, and manage env vars',
    docsUrl: 'https://vercel.com/docs/rest-api',
    setupUrl: 'https://vercel.com/account/tokens',
    docsLabel: 'Vercel REST API',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    shortLabel: 'Netlify',
    icon: '/integrations/netlify.svg',
    description: 'Deploy sites, list deploys, and manage env vars',
    docsUrl: 'https://docs.netlify.com/api/get-started/',
    setupUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    docsLabel: 'Netlify API',
  },
];

const byId = new Map(INTEGRATION_CATALOG.map((i) => [i.id, i]));

export function getIntegrationMeta(id: string): IntegrationMeta | undefined {
  return byId.get(id as IntegrationId);
}

export const INTEGRATION_IDS = INTEGRATION_CATALOG.map((i) => i.id);
