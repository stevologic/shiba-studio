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

export async function testGoogleDrive(): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!creds.googledrive?.accessToken && !creds.googledrive?.serviceAccountJson) {
    return { ok: false, error: 'No Google Drive credentials' };
  }
  try {
    const { google } = await import('googleapis');
    let auth: any;
    if (creds.googledrive.serviceAccountJson) {
      const sa = JSON.parse(creds.googledrive.serviceAccountJson);
      auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive'] });
    } else {
      auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: creds.googledrive.accessToken });
    }
    const drive = google.drive({ version: 'v3', auth });
    const about = await drive.about.get({ fields: 'user' });
    return { ok: true, email: (about.data.user as any)?.emailAddress };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export async function driveListFiles(query = '', max = 8) {
  if (!creds.googledrive?.accessToken && !creds.googledrive?.serviceAccountJson) throw new Error('Google Drive not configured');
  const { google } = await import('googleapis');
  let auth: any;
  if (creds.googledrive.serviceAccountJson) {
    const sa = JSON.parse(creds.googledrive.serviceAccountJson);
    auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  } else {
    auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: creds.googledrive.accessToken });
  }
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({ q: query || undefined, pageSize: max, fields: 'files(id,name,mimeType,webViewLink)' });
  return (res.data.files || []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink }));
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

export async function driveUploadText(name: string, content: string, parentId?: string) {
  if (!creds.googledrive?.accessToken && !creds.googledrive?.serviceAccountJson) throw new Error('Google Drive not configured');
  const { google } = await import('googleapis');
  let auth: any;
  if (creds.googledrive.serviceAccountJson) {
    const sa = JSON.parse(creds.googledrive.serviceAccountJson);
    auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/drive.file'] });
  } else {
    auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: creds.googledrive.accessToken });
  }
  const drive = google.drive({ version: 'v3', auth });
  const file = await drive.files.create({
    requestBody: { name, parents: parentId ? [parentId] : undefined },
    media: { mimeType: 'text/plain', body: content },
    fields: 'id,webViewLink,name',
  });
  return { id: file.data.id, name: file.data.name, link: file.data.webViewLink };
}
