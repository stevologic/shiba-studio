// Core integrations: GitHub, Slack, Google Drive, Gmail, YouTube, Discord, X, Reddit,
// Obsidian, Vercel, Netlify, plus Board-scoped Linear and Jira sync.
// All scoped per-agent via config. Credentials stored server-side in config.
// Lazy imports to avoid heavy top-level cjs/esm issues in tests.

import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { Block, KnownBlock } from '@slack/web-api';
import { IntegrationCreds } from './types';

let defaultCreds: IntegrationCreds = {};
const scopedCreds = new AsyncLocalStorage<IntegrationCreds>();
const creds = new Proxy({} as IntegrationCreds, {
  get(_target, property: string | symbol) {
    return Reflect.get(scopedCreds.getStore() || defaultCreds, property);
  },
});

export function setIntegrationCreds(c: IntegrationCreds) {
  defaultCreds = c || {};
}

export function getIntegrationCreds() { return scopedCreds.getStore() || defaultCreds; }

export function withIntegrationCreds<T>(
  value: IntegrationCreds | undefined,
  fn: () => T,
): T {
  return value ? scopedCreds.run(value, fn) : fn();
}

/**
 * Overlay an agent's per-integration credential overrides on top of the global
 * creds — the agent's fields win, the global fills any gaps. Only services the
 * agent actually overrode (with at least one non-empty field) are touched, so
 * everything else keeps using the global account.
 */
export function mergeAgentIntegrationCreds(
  global: IntegrationCreds,
  overrides?: IntegrationCreds,
): IntegrationCreds {
  if (!overrides) return global;
  const merged: IntegrationCreds = { ...global };
  for (const svc of Object.keys(overrides) as Array<keyof IntegrationCreds>) {
    const ov = overrides[svc] as Record<string, unknown> | undefined;
    if (!ov) continue;
    // Overlay only the fields the agent actually filled in — an empty field
    // falls back to the global account instead of clobbering it with "".
    const filled: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ov)) {
      if (typeof v === 'string' ? v.trim() : v != null) filled[k] = v;
    }
    if (!Object.keys(filled).length) continue;
    if (svc === 'reddit') {
      // The endpoint and managed token identify one Devvit app installation.
      // If an agent overrides either field, do not borrow the other half from
      // the global integration and accidentally cross an app boundary.
      const hasDevvitOverride = ['devvitEndpoint', 'devvitAppToken'].some((key) => key in filled);
      merged.reddit = {
        ...(hasDevvitOverride ? {} : (global.reddit || {})),
        ...filled,
      } as IntegrationCreds['reddit'];
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    merged[svc] = { ...(global[svc] as any), ...(filled as any) };
  }
  return merged;
}

export async function testGitHub(): Promise<{ ok: boolean; login?: string; error?: string }> {
  if (!creds.github?.token) return { ok: false, error: 'No GitHub token configured' };
  try {
    const { Octokit } = await import('octokit');
    const octo = new Octokit({ auth: creds.github.token });
    const { data } = await octo.rest.users.getAuthenticated();
    return { ok: true, login: data.login };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
    return { ok: true, team: (info as { team?: string }).team };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function slackPostMessage(channel: string, text: string, blocks?: (Block | KnownBlock)[]) {
  if (!creds.slack?.token) throw new Error('Slack not configured');
  const { WebClient } = await import('@slack/web-api');
  const slack = new WebClient(creds.slack.token);
  const res = await slack.chat.postMessage({ channel, text, blocks });
  return { ok: res.ok, ts: res.ts, channel: res.channel };
}

/** Build a Drive auth client, preferring the popup-OAuth token (auto-refreshed)
 *  then a service-account JSON, then a manually-pasted access token. */
export async function driveAuth(): Promise<unknown> {
  const { google } = await import('googleapis');
  const drive = creds.googledrive;
  const globalDrive = defaultCreds.googledrive;

  // A request-scoped agent credential must win before the global popup-OAuth
  // session. Previously the merged object still contained the global
  // refresh/client fields, so getValidDriveToken() silently selected the
  // global Drive account and ignored the agent's access token/service account.
  const scopedServiceAccount = drive?.serviceAccountJson
    && drive.serviceAccountJson !== globalDrive?.serviceAccountJson;
  if (scopedServiceAccount) {
    const sa = JSON.parse(drive.serviceAccountJson!);
    return new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive'] });
  }
  const scopedAccessToken = drive?.accessToken
    && drive.accessToken !== globalDrive?.accessToken;
  if (scopedAccessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: drive.accessToken });
    return auth;
  }

  if (drive?.clientId || drive?.refreshToken) {
    const { getValidDriveToken } = await import('./google-oauth');
    const token = await getValidDriveToken();
    if (token) {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: token });
      return auth;
    }
  }
  if (drive?.serviceAccountJson) {
    const sa = JSON.parse(drive.serviceAccountJson);
    return new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive'] });
  }
  if (drive?.accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: drive.accessToken });
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

async function gmailAuth(): Promise<unknown> {
  const { google } = await import('googleapis');
  const gmail = creds.gmail;
  const globalGmail = defaultCreds.gmail;
  const scopedAccessToken = gmail?.accessToken
    && gmail.accessToken !== globalGmail?.accessToken;
  if (scopedAccessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: gmail.accessToken });
    return auth;
  }
  const { getValidGmailToken } = await import('./google-oauth');
  const token = await getValidGmailToken();
  if (token) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    return auth;
  }
  if (gmail?.accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: gmail.accessToken });
    return auth;
  }
  return null;
}

async function gmailClient() {
  const auth = await gmailAuth();
  if (!auth) throw new Error('Gmail not configured — sign in with Google on the Capabilities page');
  const { google } = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return google.gmail({ version: 'v1', auth: auth as any });
}

export async function testGmail(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const auth = await gmailAuth();
    if (!auth) return { ok: false, error: 'No Gmail credentials — sign in with Google' };
    const { google } = await import('googleapis');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gmail = google.gmail({ version: 'v1', auth: auth as any });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return { ok: true, email: profile.data.emailAddress || undefined };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gmail test failed' };
  }
}

export async function gmailListMessages(query = '', max = 10) {
  const { parseGmailPayload } = await import('./gmail');
  const gmail = await gmailClient();
  const limit = Math.max(1, Math.min(25, Number(max) || 10));
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: String(query || '').slice(0, 500) || undefined,
    maxResults: limit,
  });
  const ids = (list.data.messages || []).map((m) => m.id).filter((id): id is string => !!id);
  const messages = [];
  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const parsed = parseGmailPayload(full.data.payload, {
      id: full.data.id || id,
      threadId: full.data.threadId || '',
      snippet: full.data.snippet || '',
      labelIds: full.data.labelIds,
    });
    messages.push({
      id: parsed.id,
      threadId: parsed.threadId,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      date: parsed.date,
      snippet: parsed.snippet,
      unread: parsed.unread,
    });
  }
  return messages;
}

export async function gmailReadMessage(id: string) {
  const { assertGmailMessageId, parseGmailPayload } = await import('./gmail');
  const gmail = await gmailClient();
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: assertGmailMessageId(id),
    format: 'full',
  });
  return parseGmailPayload(full.data.payload, {
    id: full.data.id || id,
    threadId: full.data.threadId || '',
    snippet: full.data.snippet || '',
    labelIds: full.data.labelIds,
  });
}

export async function gmailSendMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  threadId?: string;
}): Promise<{ id: string; threadId: string; to: string[] }> {
  const { assertGmailMessageId, encodeGmailRfc2822, gmailHeader, parseEmailList } = await import('./gmail');
  const to = parseEmailList(input.to);
  if (!to.length) throw new Error('gmail_send requires at least one To address');
  const cc = input.cc ? parseEmailList(input.cc) : [];
  const bcc = input.bcc ? parseEmailList(input.bcc) : [];
  const subject = String(input.subject || '').trim();
  if (!subject) throw new Error('gmail_send requires a subject');
  const body = String(input.body || '');
  if (!body.trim()) throw new Error('gmail_send requires a body');

  let inReplyTo = '';
  let references = '';
  const threadId = input.threadId ? assertGmailMessageId(input.threadId) : '';
  const gmail = await gmailClient();
  if (threadId) {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'],
    });
    const last = (thread.data.messages || []).at(-1);
    inReplyTo = gmailHeader(last?.payload?.headers || [], 'Message-ID');
    references = [gmailHeader(last?.payload?.headers || [], 'References'), inReplyTo].filter(Boolean).join(' ');
  }

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodeGmailRfc2822({ to, cc, bcc, subject, body, inReplyTo, references }),
      ...(threadId ? { threadId } : {}),
    },
  });
  return {
    id: sent.data.id || '',
    threadId: sent.data.threadId || threadId,
    to,
  };
}

async function youtubeAuth(): Promise<unknown> {
  const { google } = await import('googleapis');
  const youtube = creds.youtube;
  const globalYoutube = defaultCreds.youtube;
  const scopedAccessToken = youtube?.accessToken
    && youtube.accessToken !== globalYoutube?.accessToken;
  if (scopedAccessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: youtube.accessToken });
    return auth;
  }
  const { getValidYoutubeToken } = await import('./google-oauth');
  const token = await getValidYoutubeToken();
  if (token) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    return auth;
  }
  if (youtube?.accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: youtube.accessToken });
    return auth;
  }
  return null;
}

async function youtubeClient() {
  const auth = await youtubeAuth();
  if (!auth) throw new Error('YouTube not configured — sign in with Google on the Capabilities page');
  const { google } = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return google.youtube({ version: 'v3', auth: auth as any });
}

export async function testYoutube(): Promise<{ ok: boolean; email?: string; channelTitle?: string; channelId?: string; error?: string }> {
  try {
    const auth = await youtubeAuth();
    if (!auth) return { ok: false, error: 'No YouTube credentials — sign in with Google' };
    const { google } = await import('googleapis');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const youtube = google.youtube({ version: 'v3', auth: auth as any });
    const channels = await youtube.channels.list({ part: ['snippet', 'contentDetails'], mine: true });
    const channel = channels.data.items?.[0];
    return {
      ok: true,
      channelId: channel?.id || undefined,
      channelTitle: channel?.snippet?.title || undefined,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'YouTube test failed' };
  }
}

export async function youtubeSearchVideos(query: string, max = 8) {
  const q = String(query || '').trim();
  if (!q) throw new Error('youtube_search requires a query');
  const youtube = await youtubeClient();
  const limit = Math.max(1, Math.min(15, Number(max) || 8));
  const res = await youtube.search.list({
    part: ['snippet'],
    q: q.slice(0, 200),
    type: ['video'],
    maxResults: limit,
  });
  return (res.data.items || []).map((item) => {
    const id = item.id?.videoId || '';
    return {
      id,
      title: item.snippet?.title || '',
      channel: item.snippet?.channelTitle || '',
      publishedAt: item.snippet?.publishedAt || '',
      description: (item.snippet?.description || '').slice(0, 280),
      url: id ? `https://www.youtube.com/watch?v=${id}` : '',
    };
  }).filter((v) => v.id);
}

export async function youtubeListMine(max = 8) {
  const youtube = await youtubeClient();
  const limit = Math.max(1, Math.min(15, Number(max) || 8));
  const channels = await youtube.channels.list({ part: ['contentDetails', 'snippet'], mine: true });
  const channel = channels.data.items?.[0];
  const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channelTitle: channel?.snippet?.title || '', videos: [] as Array<Record<string, string>> };
  const items = await youtube.playlistItems.list({
    part: ['snippet', 'contentDetails'],
    playlistId: uploads,
    maxResults: limit,
  });
  return {
    channelTitle: channel?.snippet?.title || '',
    channelId: channel?.id || '',
    videos: (items.data.items || []).map((item) => {
      const id = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId || '';
      return {
        id,
        title: item.snippet?.title || '',
        publishedAt: item.snippet?.publishedAt || item.contentDetails?.videoPublishedAt || '',
        url: id ? `https://www.youtube.com/watch?v=${id}` : '',
      };
    }).filter((v) => v.id),
  };
}

export async function youtubeGetVideo(idOrUrl: string) {
  const { parseYoutubeVideoId, youtubeWatchUrl } = await import('./youtube');
  const id = parseYoutubeVideoId(idOrUrl);
  const youtube = await youtubeClient();
  const res = await youtube.videos.list({
    part: ['snippet', 'contentDetails', 'statistics', 'status'],
    id: [id],
  });
  const video = res.data.items?.[0];
  if (!video) throw new Error(`YouTube video not found: ${id}`);
  return {
    id,
    title: video.snippet?.title || '',
    channel: video.snippet?.channelTitle || '',
    publishedAt: video.snippet?.publishedAt || '',
    description: (video.snippet?.description || '').slice(0, 2_000),
    duration: video.contentDetails?.duration || '',
    privacy: video.status?.privacyStatus || '',
    views: video.statistics?.viewCount || '',
    url: youtubeWatchUrl(id),
  };
}

export async function youtubeUploadVideo(input: {
  filePath: string;
  title: string;
  description?: string;
  privacy?: string;
}): Promise<{ id: string; url: string; title: string; privacy: string }> {
  const { assertYoutubeUploadPath, parseYoutubePrivacy, youtubeWatchUrl } = await import('./youtube');
  const filePath = assertYoutubeUploadPath(input.filePath);
  const title = String(input.title || '').trim().slice(0, 100);
  if (!title) throw new Error('youtube_upload requires a title');
  const privacy = parseYoutubePrivacy(input.privacy, 'unlisted');
  const fs = await import('fs');
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Video file not found: ${filePath}`);
  const MAX_BYTES = 256 * 1024 * 1024;
  if (stat.size > MAX_BYTES) throw new Error('YouTube upload is limited to 256 MB from this studio');
  const youtube = await youtubeClient();
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description: String(input.description || '').slice(0, 5_000),
        categoryId: '22',
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  const id = res.data.id || '';
  if (!id) throw new Error('YouTube upload returned no video id');
  return { id, url: youtubeWatchUrl(id), title, privacy };
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
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
    // Don't pre-truncate at 280 — X Premium/Premium+ accounts post long-form
    // (up to 25k chars). Send the full text (capped at X's absolute max) and let
    // the API enforce the account's real limit rather than silently cutting it.
    body: JSON.stringify({ text: text.slice(0, 25000) }),
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

/** Reddit is accessed through the installed Devvit companion app. */
export async function testReddit() {
  const { testReddit: test } = await import('./reddit');
  return test({ reddit: creds.reddit });
}

export async function redditReadPosts(input: {
  subreddit?: string;
  sort?: 'hot' | 'new' | 'top' | 'rising';
  time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  limit?: number;
  after?: string;
}) {
  const { redditReadPosts: read } = await import('./reddit');
  return read(input, { reddit: creds.reddit });
}

export async function redditSubmit(input: {
  subreddit: string;
  title: string;
  kind?: 'self' | 'link';
  text?: string;
  url?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  sendReplies?: boolean;
}) {
  const { redditSubmit: submit } = await import('./reddit');
  return submit(input, { reddit: creds.reddit });
}

export {
  testObsidian,
  obsidianListNotes,
  obsidianReadNote,
  obsidianWriteNote,
  obsidianSearch,
} from './obsidian';

export {
  testVercel,
  vercelListProjects,
  vercelGetProject,
  vercelListDeployments,
  vercelGetDeployment,
  vercelDeploy,
  vercelSetEnv,
} from './vercel';

export {
  testNetlify,
  netlifyListSites,
  netlifyGetSite,
  netlifyListDeploys,
  netlifyGetDeploy,
  netlifyDeploy,
  netlifySetEnv,
} from './netlify';

export { testLinear } from './linear';
export { testJira } from './jira';

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
