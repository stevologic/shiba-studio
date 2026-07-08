// Core integrations: GitHub, Slack, Google Drive, Discord, X, Obsidian
// All scoped per-agent via config. Credentials stored server-side in config.
// Lazy imports to avoid heavy top-level cjs/esm issues in tests.

import crypto from 'crypto';
import { IntegrationCreds } from './types';

let creds: IntegrationCreds = {};

export function setIntegrationCreds(c: IntegrationCreds) {
  creds = c || {};
}

export function getIntegrationCreds() { return creds; }

export async function testGitHub(): Promise<{ ok: boolean; login?: string; error?: string }> {
  if (!creds.github?.token) return { ok: false, error: 'No GitHub token configured' };
  try {
    const { Octokit } = await import('octokit');
    const octo = new Octokit({ auth: creds.github.token });
    const { data } = await octo.rest.users.getAuthenticated();
    return { ok: true, login: data.login };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function githubCreateIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]) {
  if (!creds.github?.token) throw new Error('GitHub not configured');
  const { Octokit } = await import('octokit');
  const octo = new Octokit({ auth: creds.github.token });
  const res = await octo.rest.issues.create({ owner, repo, title, body, labels });
  return { url: res.data.html_url, number: res.data.number };
}

export async function githubCreatePr(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
) {
  if (!creds.github?.token) throw new Error('GitHub not configured — add a token on the Capabilities page');
  const { Octokit } = await import('octokit');
  const octo = new Octokit({ auth: creds.github.token });
  const res = await octo.rest.pulls.create({ owner, repo, title, head, base, body });
  return { url: res.data.html_url, number: res.data.number };
}

export async function githubListRepos() {
  if (!creds.github?.token) throw new Error('GitHub not configured');
  const { Octokit } = await import('octokit');
  const octo = new Octokit({ auth: creds.github.token });
  const { data } = await octo.rest.repos.listForAuthenticatedUser({ per_page: 10, sort: 'updated' });
  return data.map(r => ({ name: r.full_name, url: r.html_url, private: r.private }));
}

export async function testSlack(): Promise<{ ok: boolean; team?: string; error?: string }> {
  if (!creds.slack?.token) return { ok: false, error: 'No Slack token' };
  try {
    const { WebClient } = await import('@slack/web-api');
    const slack = new WebClient(creds.slack.token);
    const info = await slack.auth.test();
    return { ok: true, team: (info as any).team };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export async function slackPostMessage(channel: string, text: string, blocks?: any) {
  if (!creds.slack?.token) throw new Error('Slack not configured');
  const { WebClient } = await import('@slack/web-api');
  const slack = new WebClient(creds.slack.token);
  const res = await slack.chat.postMessage({ channel, text, blocks });
  return { ok: res.ok, ts: res.ts, channel: res.channel };
}

/** Build a Drive auth client, preferring the popup-OAuth token (auto-refreshed)
 *  then a service-account JSON, then a manually-pasted access token. */
async function driveAuth(): Promise<unknown> {
  const { google } = await import('googleapis');
  if (creds.googledrive?.clientId || creds.googledrive?.refreshToken) {
    const { getValidDriveToken } = await import('./google-oauth');
    const token = await getValidDriveToken();
    if (token) {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: token });
      return auth;
    }
  }
  if (creds.googledrive?.serviceAccountJson) {
    const sa = JSON.parse(creds.googledrive.serviceAccountJson);
    return new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive'] });
  }
  if (creds.googledrive?.accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: creds.googledrive.accessToken });
    return auth;
  }
  return null;
}

export async function testGoogleDrive(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const auth = await driveAuth();
    if (!auth) return { ok: false, error: 'No Google Drive credentials — sign in with Google or add a service account' };
    const { google } = await import('googleapis');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drive = google.drive({ version: 'v3', auth: auth as any });
    const about = await drive.about.get({ fields: 'user' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, email: (about.data.user as any)?.emailAddress };
  } catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : 'Drive test failed' }; }
}

export async function driveListFiles(query = '', max = 8, allowedFolders?: string[]) {
  const auth = await driveAuth();
  if (!auth) throw new Error('Google Drive not configured');
  const { google } = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drive = google.drive({ version: 'v3', auth: auth as any });
  const folders = (allowedFolders || []).filter(Boolean);
  // Folder isolation: constrain the query to files that live directly in an
  // allowed folder, then filter defensively on the returned parents.
  let q = query || '';
  if (folders.length) {
    const inParents = folders.map((id) => `'${id.replace(/'/g, "\\'")}' in parents`).join(' or ');
    q = q ? `(${q}) and (${inParents})` : `(${inParents})`;
  }
  const res = await drive.files.list({ q: q || undefined, pageSize: max, fields: 'files(id,name,mimeType,webViewLink,parents)' });
  let files = res.data.files || [];
  if (folders.length) {
    const allow = new Set(folders);
    files = files.filter((f) => (f.parents || []).some((p) => allow.has(p)));
  }
  return files.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink }));
}

/** List the connected Drive's folders — powers the per-agent folder picker. */
export async function driveListFolders(max = 200): Promise<Array<{ id: string; name: string }>> {
  const auth = await driveAuth();
  if (!auth) throw new Error('Google Drive not configured');
  const { google } = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drive = google.drive({ version: 'v3', auth: auth as any });
  const res = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    pageSize: max,
    fields: 'files(id,name)',
    orderBy: 'name',
  });
  return (res.data.files || []).map((f) => ({ id: f.id || '', name: f.name || '(unnamed)' })).filter((f) => f.id);
}

const DISCORD_API = 'https://discord.com/api/v10';

function discordBotHeaders(token: string) {
  const t = token.trim().replace(/^Bot\s+/i, '');
  return {
    Authorization: `Bot ${t}`,
    'Content-Type': 'application/json',
  };
}

export async function testDiscord(): Promise<{ ok: boolean; username?: string; id?: string; error?: string }> {
  if (!creds.discord?.token) return { ok: false, error: 'No Discord bot token configured' };
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, { headers: discordBotHeaders(creds.discord.token) });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `${res.status} ${txt}` };
    }
    const data = await res.json();
    return { ok: true, username: data.username, id: data.id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function discordPostMessage(channelId: string, text: string) {
  if (!creds.discord?.token) throw new Error('Discord not configured');
  const channel = channelId || creds.discord.defaultChannelId;
  if (!channel) throw new Error('Discord channel id required');
  const res = await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
    method: 'POST',
    headers: discordBotHeaders(creds.discord.token),
    body: JSON.stringify({ content: text.slice(0, 2000) }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord API ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return { ok: true, id: data.id, channel_id: data.channel_id };
}

const X_API = 'https://api.twitter.com/2';

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xOAuth1Auth(
  method: string,
  url: string,
  keys: { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string },
  extraParams: Record<string, string> = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: keys.accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauth, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(keys.apiSecret)}&${percentEncode(keys.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  const signed = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.entries(signed)
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(', ')
  );
}

function getXCreds(): NonNullable<IntegrationCreds['x']> | null {
  const keys = creds.x;
  if (!keys?.apiKey || !keys?.apiSecret || !keys?.accessToken || !keys?.accessTokenSecret) return null;
  return keys;
}

export async function testX(): Promise<{ ok: boolean; username?: string; id?: string; error?: string }> {
  const keys = getXCreds();
  if (!keys) return { ok: false, error: 'X API credentials incomplete (need API key, secret, access token, and access token secret)' };
  try {
    const url = `${X_API}/users/me`;
    const query = { 'user.fields': 'username' };
    const auth = xOAuth1Auth('GET', url, keys, query);
    const res = await fetch(`${url}?user.fields=username`, { headers: { Authorization: auth } });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `${res.status} ${txt}` };
    }
    const data = await res.json();
    return { ok: true, username: data.data?.username, id: data.data?.id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export interface XTweet {
  id: string;
  text: string;
  createdAt?: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  url: string;
  author?: string;
}

/** Read recent tweets — your own posts, or your home timeline. */
export async function xReadTimeline(feed: 'mine' | 'home' = 'mine', count = 5): Promise<XTweet[]> {
  const keys = getXCreds();
  if (!keys) throw new Error('X not configured');

  // Resolve the authenticated user's id first.
  const meUrl = `${X_API}/users/me`;
  const meRes = await fetch(meUrl, { headers: { Authorization: xOAuth1Auth('GET', meUrl, keys) } });
  if (!meRes.ok) throw new Error(`X API ${meRes.status}: ${(await meRes.text()).slice(0, 300)}`);
  const me = await meRes.json();
  const userId = me.data?.id;
  if (!userId) throw new Error('Could not resolve the authenticated X user');

  const max = Math.min(Math.max(Math.floor(count) || 5, 5), 25); // API minimum is 5
  const path = feed === 'home'
    ? `${X_API}/users/${userId}/timelines/reverse_chronological`
    : `${X_API}/users/${userId}/tweets`;
  const query: Record<string, string> = {
    max_results: String(max),
    'tweet.fields': 'created_at,public_metrics,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  };
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${path}?${qs}`, { headers: { Authorization: xOAuth1Auth('GET', path, keys, query) } });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `X refused the timeline read (${res.status}). Reading tweets requires at least the Basic API tier at developer.x.com — the Free tier only allows posting and identity lookups. Details: ${txt.slice(0, 200)}`,
      );
    }
    throw new Error(`X API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const users = new Map<string, string>(
    ((data.includes?.users || []) as Array<{ id: string; username: string }>).map((u) => [u.id, u.username]),
  );
  return ((data.data || []) as Array<Record<string, unknown>>).map((t) => ({
    id: String(t.id),
    text: String(t.text || ''),
    createdAt: t.created_at ? String(t.created_at) : undefined,
    likes: (t.public_metrics as Record<string, number> | undefined)?.like_count,
    reposts: (t.public_metrics as Record<string, number> | undefined)?.retweet_count,
    replies: (t.public_metrics as Record<string, number> | undefined)?.reply_count,
    author: t.author_id ? users.get(String(t.author_id)) : undefined,
    url: `https://x.com/i/web/status/${t.id}`,
  }));
}

export async function xPostTweet(text: string) {
  const keys = getXCreds();
  if (!keys) throw new Error('X not configured');
  const url = `${X_API}/tweets`;
  const auth = xOAuth1Auth('POST', url, keys);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 280) }),
  });
  if (!res.ok) {
    const txt = await res.text();
    // The most common failure: the X app is Read-only. Auth tests pass but
    // posting 403s — and tokens keep the permission level they were CREATED
    // with, so regeneration after the change is mandatory.
    if (res.status === 403 && /oauth1.?permissions/i.test(txt)) {
      throw new Error(
        'X refused the post (403): the app\'s permissions are Read-only. At developer.x.com set App permissions to "Read and write", then REGENERATE the Access Token & Secret (existing tokens keep their old permission level) and re-save them on the Capabilities page.',
      );
    }
    throw new Error(`X API ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const id = data.data?.id;
  return { ok: true, id, url: id ? `https://x.com/i/web/status/${id}` : undefined };
}

export {
  testObsidian,
  obsidianListNotes,
  obsidianReadNote,
  obsidianWriteNote,
  obsidianSearch,
} from './obsidian';

export async function driveUploadText(name: string, content: string, allowedFolders?: string[]) {
  const auth = await driveAuth();
  if (!auth) throw new Error('Google Drive not configured');
  const { google } = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drive = google.drive({ version: 'v3', auth: auth as any });
  const folders = (allowedFolders || []).filter(Boolean);
  // Folder isolation: a scoped agent writes into its first allowed folder,
  // never loose in the Drive root.
  const parents = folders.length ? [folders[0]] : undefined;
  const file = await drive.files.create({
    requestBody: { name, parents },
    media: { mimeType: 'text/plain', body: content },
    fields: 'id,webViewLink,name',
  });
  return { id: file.data.id, name: file.data.name, link: file.data.webViewLink };
}
