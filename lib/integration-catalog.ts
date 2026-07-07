/** UI catalog for Shiba Studio integrations. */

export type IntegrationId = 'github' | 'slack' | 'googledrive' | 'discord' | 'x' | 'obsidian';

export interface IntegrationMeta {
  id: IntegrationId;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
}

export const INTEGRATION_CATALOG: IntegrationMeta[] = [
  {
    id: 'github',
    label: 'GitHub',
    shortLabel: 'GitHub',
    icon: '/integrations/github.svg',
    description: 'Repos, commits, and pull requests',
  },
  {
    id: 'slack',
    label: 'Slack',
    shortLabel: 'Slack',
    icon: '/integrations/slack.svg',
    description: 'Post messages to channels',
  },
  {
    id: 'googledrive',
    label: 'Google Drive',
    shortLabel: 'Drive',
    icon: '/integrations/googledrive.svg',
    description: 'Read and write Drive files',
  },
  {
    id: 'discord',
    label: 'Discord',
    shortLabel: 'Discord',
    icon: '/integrations/discord.svg',
    description: 'Post messages to channels via bot',
  },
  {
    id: 'x',
    label: 'X',
    shortLabel: 'X',
    icon: '/integrations/x.svg',
    description: 'Post tweets to your X account',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    shortLabel: 'Obsidian',
    icon: '/integrations/obsidian.svg',
    description: 'Read, write, and search notes in your vault',
  },
];

const byId = new Map(INTEGRATION_CATALOG.map((i) => [i.id, i]));

export function getIntegrationMeta(id: string): IntegrationMeta | undefined {
  return byId.get(id as IntegrationId);
}

export const INTEGRATION_IDS = INTEGRATION_CATALOG.map((i) => i.id);