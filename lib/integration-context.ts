// Ambient context from an agent's enabled integrations, injected into system
// prompts for both autonomous runs and Grok Chat conversations. Example: an
// agent with Obsidian enabled receives its vault index plus note contents (up
// to a budget) so the model has the vault's knowledge, not just tools.
// Everything is best-effort, time-boxed, and briefly cached.

import type { IntegrationScope } from './types';
import { getIntegrationCreds, testGitHub, githubListRepos, testSlack, driveListFiles, testDiscord, testX, testVercel, vercelListProjects } from './integrations';
import { obsidianListNotes, obsidianReadNote, getObsidianConfig } from './obsidian';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: string }>();

/** Total characters of Obsidian note content inlined into the prompt. */
const VAULT_CONTENT_BUDGET = 24_000;
const VAULT_NOTE_LIMIT = 200;
const PER_CALL_TIMEOUT_MS = 6_000;

function withTimeout<T>(p: Promise<T>, ms = PER_CALL_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('integration context timed out')), ms)),
  ]);
}

async function obsidianContext(): Promise<string> {
  const creds = getIntegrationCreds();
  const cfg = getObsidianConfig(creds);
  if (!cfg) return '';
  const notes = await withTimeout(obsidianListNotes(creds, '', VAULT_NOTE_LIMIT));
  if (!notes.length) return '### Obsidian vault\nConnected, but the vault has no notes yet.';

  const lines: string[] = [
    `### Obsidian vault (${cfg.mode === 'cloud' ? 'REST' : cfg.vaultPath || 'local'}) — ${notes.length} note(s)`,
    'Note index:',
    ...notes.map((n) => `- ${n.path}`),
  ];

  // Inline note contents until the budget is spent — small vaults are fully
  // in context; larger ones keep the index and the obsidian_read tool.
  let budget = VAULT_CONTENT_BUDGET;
  const included: string[] = [];
  for (const n of notes) {
    if (budget <= 400) break;
    try {
      const content = (await withTimeout(obsidianReadNote(creds, n.path), 3000)).trim();
      if (!content) continue;
      const slice = content.slice(0, Math.min(content.length, budget));
      budget -= slice.length + n.path.length + 20;
      included.push(`--- ${n.path} ---\n${slice}${slice.length < content.length ? '\n…(truncated)' : ''}`);
    } catch {
      /* unreadable note — index entry remains */
    }
  }
  if (included.length) {
    lines.push('', `Vault contents (${included.length} of ${notes.length} notes inlined):`, ...included);
    if (included.length < notes.length) {
      lines.push('', 'Remaining notes are in the index above — read them with the obsidian_read tool.');
    }
  }
  return lines.join('\n');
}

async function githubContext(): Promise<string> {
  const who = await withTimeout(testGitHub());
  if (!who.ok) return '';
  let repoLine = '';
  try {
    const repos = (await withTimeout(githubListRepos())) as Array<{ full_name?: string; name?: string }>;
    const names = repos.slice(0, 20).map((r) => r.full_name || r.name).filter(Boolean);
    if (names.length) repoLine = `\nAccessible repos: ${names.join(', ')}`;
  } catch {
    /* repo list optional */
  }
  return `### GitHub\nAuthenticated as ${who.login}.${repoLine}`;
}

async function slackContext(): Promise<string> {
  const t = await withTimeout(testSlack());
  if (!t.ok) return '';
  const channel = getIntegrationCreds().slack?.defaultChannel;
  return `### Slack\nConnected to workspace "${t.team}".${channel ? ` Default channel: ${channel}.` : ''}`;
}

async function driveContext(driveFolders?: Array<{ id: string; name: string }>): Promise<string> {
  try {
    const folders = (driveFolders || []).filter((f) => f?.id);
    const folderIds = folders.map((f) => f.id);
    const files = (await withTimeout(driveListFiles('', 8, folderIds.length ? folderIds : undefined))) as Array<{ name?: string }>;
    const names = files.map((f) => f.name).filter(Boolean);
    const scopeNote = folders.length
      ? `\nScope: restricted to these folders only — ${folders.map((f) => f.name).join(', ')}. List and upload stay inside them; do not attempt other locations.`
      : '';
    if (!names.length) return `### Google Drive\nConnected (no files listed).${scopeNote}`;
    return `### Google Drive\nRecent files: ${names.join(', ')}${scopeNote}`;
  } catch {
    return '';
  }
}

async function discordContext(): Promise<string> {
  const t = await withTimeout(testDiscord());
  if (!t.ok) return '';
  const channel = getIntegrationCreds().discord?.defaultChannelId;
  return `### Discord\nBot connected as ${t.username}.${channel ? ` Default channel id: ${channel}.` : ''}`;
}

async function xContext(): Promise<string> {
  const t = await withTimeout(testX());
  if (!t.ok) return '';
  return `### X\nPosting as @${t.username}.`;
}

async function vercelContext(): Promise<string> {
  const t = await withTimeout(testVercel());
  if (!t.ok) return '';
  const creds = getIntegrationCreds().vercel;
  let projectsLine = '';
  try {
    const projects = await withTimeout(vercelListProjects(12));
    if (projects.length) {
      projectsLine = `\nProjects: ${projects.map((p) => p.name).join(', ')}`;
    }
  } catch {
    /* optional */
  }
  const team = t.team ? ` · team ${t.team}` : '';
  const def = creds?.defaultProject ? `\nDefault project: ${creds.defaultProject}.` : '';
  return `### Vercel\nAuthenticated as ${t.user || 'token user'}${team}.${def}${projectsLine}\nUse vercel_deploy to ship; vercel_list_deployments / vercel_get_deployment to check status.`;
}

/**
 * Live context for every enabled integration in the scope. Returns '' when
 * nothing is enabled or nothing is reachable — callers can append verbatim.
 */
export async function buildIntegrationContext(
  scope: IntegrationScope,
  driveFolders?: Array<{ id: string; name: string }>,
): Promise<string> {
  const enabled = Object.entries(scope).filter(([, v]) => v).map(([k]) => k);
  if (!enabled.length) return '';

  // Folder scope is part of the cache identity — a differently-scoped agent
  // must not read another's cached Drive context.
  const folderKey = (driveFolders || []).map((f) => f.id).sort().join('|');
  const key = enabled.sort().join(',') + (folderKey ? `#drive:${folderKey}` : '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const builders: Record<string, () => Promise<string>> = {
    obsidian: obsidianContext,
    github: githubContext,
    slack: slackContext,
    googledrive: () => driveContext(driveFolders),
    discord: discordContext,
    x: xContext,
    vercel: vercelContext,
  };

  const sections = await Promise.all(
    enabled.map(async (id) => {
      try {
        return await builders[id]?.() || '';
      } catch {
        return '';
      }
    }),
  );

  const body = sections.filter(Boolean).join('\n\n');
  const value = body
    ? `## Connected integration context (live)\nYou have live access to these services — the context below is current. Use the matching tools to act on them.\n\n${body}`
    : '';
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook — clears the short-lived context cache. */
export function clearIntegrationContextCache(): void {
  cache.clear();
}
