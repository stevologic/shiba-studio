/**
 * Reddit core integration backed by the bundled Devvit companion app.
 *
 * Shiba never receives Reddit OAuth credentials. It calls three fixed Devvit
 * External Endpoints with a managed app token; Devvit owns Reddit API auth and
 * constrains every operation to the endpoint's subreddit installation.
 */

import type { IntegrationCreds } from './types';

export type RedditPostSort = 'hot' | 'new' | 'top' | 'rising';
export type RedditPostTime = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditReadPostsInput {
  /** Omit to use the community where the Devvit endpoint is installed. */
  subreddit?: string;
  sort?: RedditPostSort;
  time?: RedditPostTime;
  limit?: number;
  after?: string;
}

export interface RedditPost {
  id: string;
  fullname: string;
  subreddit: string;
  title: string;
  author: string;
  selfText: string;
  url: string;
  permalink: string;
  score: number;
  comments: number;
  createdAt?: string;
  nsfw: boolean;
  spoiler: boolean;
  isSelf: boolean;
}

export interface RedditReadPostsResult {
  posts: RedditPost[];
  nextAfter: string | null;
}

export interface RedditSubmitInput {
  subreddit: string;
  title: string;
  kind?: 'self' | 'link';
  text?: string;
  url?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  sendReplies?: boolean;
}

export interface RedditSubmitResult {
  ok: true;
  id: string;
  fullname: string;
  url: string;
  subreddit: string;
  title: string;
  author?: string;
}

export interface RedditDevvitStatus {
  ok: true;
  provider: 'devvit';
  protocolVersion: 1;
  appSlug: string;
  appAccount: string;
  appAccountId?: string;
  subreddit: string;
  subredditId: string;
  capabilities: RedditDevvitCapability[];
}

type JsonRecord = Record<string, unknown>;
type RedditCreds = NonNullable<IntegrationCreds['reddit']>;
type RedditDevvitCapability = typeof REQUIRED_CAPABILITIES[number];

const PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUIRED_CAPABILITIES = ['read_posts', 'submit_post'] as const;
const SORTS = new Set<RedditPostSort>(['hot', 'new', 'top', 'rising']);
const TIMES = new Set<RedditPostTime>(['hour', 'day', 'week', 'month', 'year', 'all']);
const ENDPOINTS = {
  status: '/external/shiba/status',
  read: '/external/shiba/posts/read',
  submit: '/external/shiba/posts/submit',
} as const;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function responseSubreddit(value: unknown): string {
  const subreddit = stringValue(value).trim();
  return /^[A-Za-z0-9_]{1,21}$/.test(subreddit) ? subreddit : '';
}

function sameSubreddit(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * External-endpoint origins are an SSRF boundary. Accept only Reddit's
 * documented installation host shape and append route paths ourselves.
 */
export function normalizeRedditDevvitEndpoint(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Reddit Devvit external endpoint is required');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Reddit Devvit endpoint must be a valid HTTPS origin');
  }
  if (url.protocol !== 'https:') throw new Error('Reddit Devvit endpoint must use HTTPS');
  if (url.username || url.password) throw new Error('Reddit Devvit endpoint cannot contain credentials');
  if (url.port) throw new Error('Reddit Devvit endpoint cannot use a custom port');
  if (url.search || url.hash) throw new Error('Reddit Devvit endpoint cannot contain a query or fragment');
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Enter only the Reddit Devvit external endpoint origin, without a route path');
  }
  const hostname = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+-external\.devvit\.net$/.test(hostname)) {
    throw new Error('Reddit Devvit endpoint must be an official *-external.devvit.net origin');
  }
  return `https://${hostname}`;
}

function resolveCreds(creds?: IntegrationCreds): { endpoint: string; token: string } {
  const provider: RedditCreds = creds?.reddit || {};
  const endpoint = normalizeRedditDevvitEndpoint(provider.devvitEndpoint || '');
  const token = provider.devvitAppToken?.trim() || '';
  if (!token) throw new Error('Reddit Devvit managed app token is required');
  if (!/^devvit_at_\S{8,}$/.test(token) || token.length > 2_048) {
    throw new Error('Reddit Devvit managed app token must start with devvit_at_');
  }
  return { endpoint, token };
}

async function readPayload(response: Response): Promise<{ payload?: unknown; text: string }> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Reddit Devvit bridge response exceeded the size limit');
  }
  if (!response.body) return { text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Reddit Devvit bridge response exceeded the size limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return { text: '' };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { text };
  }
}

function bridgeError(payload: unknown, fallback: string): string {
  const root = record(payload);
  const message = stringValue(root?.error || root?.message).trim();
  return (message || fallback || 'Reddit Devvit bridge rejected the request').slice(0, 800);
}

function assertProtocol(payload: unknown): JsonRecord {
  const root = record(payload);
  if (!root) throw new Error('Reddit Devvit bridge returned invalid JSON');
  if (root.ok !== true) throw new Error(bridgeError(root, 'Reddit Devvit bridge request failed'));
  if (root.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported Reddit Devvit bridge protocol: ${String(root.protocolVersion)}`);
  }
  return root;
}

async function devvitRequest(
  route: keyof typeof ENDPOINTS,
  body: JsonRecord,
  creds?: IntegrationCreds,
): Promise<JsonRecord> {
  const { endpoint, token } = resolveCreds(creds);
  let response: Response;
  try {
    response = await fetch(`${endpoint}${ENDPOINTS[route]}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('Reddit Devvit bridge timed out');
    }
    throw error;
  }
  const { payload, text } = await readPayload(response);
  if (!response.ok) {
    throw new Error(`Reddit Devvit bridge ${response.status}: ${bridgeError(payload, text || response.statusText)}`);
  }
  return assertProtocol(payload);
}

/** Accept `foo`, `r/foo`, `/r/foo/`, or a reddit.com `/r/foo` URL. */
export function normalizeSubreddit(value: string): string {
  let candidate = value.trim();
  if (!candidate) throw new Error('subreddit is required');

  if (/^https?:\/\//i.test(candidate)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('subreddit must be a subreddit name or reddit.com /r/ URL');
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) {
      throw new Error('subreddit URL must use reddit.com');
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'r') {
      throw new Error('subreddit URL must have the form https://www.reddit.com/r/name');
    }
    candidate = parts[1];
  } else {
    candidate = candidate
      .replace(/^(?:www\.)?reddit\.com\/r\//i, '')
      .replace(/^\/?r\//i, '')
      .replace(/^\/+|\/+$/g, '');
  }

  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    throw new Error('subreddit contains invalid URL encoding');
  }
  if (!/^[A-Za-z0-9_]{1,21}$/.test(candidate)) {
    throw new Error('subreddit must contain only letters, numbers, or underscores (maximum 21 characters)');
  }
  return candidate;
}

function redditPermalink(value: unknown): string {
  const raw = stringValue(value).trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw, 'https://www.reddit.com');
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.port
    || (host !== 'reddit.com' && !host.endsWith('.reddit.com'))
  ) {
    return '';
  }
  return url.toString();
}

function permalinkMatchesPost(permalink: string, subreddit: string, id: string): boolean {
  let url: URL;
  try {
    url = new URL(permalink);
  } catch {
    return false;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0].toLowerCase() !== 'r' || parts[2].toLowerCase() !== 'comments') {
    return false;
  }
  try {
    return sameSubreddit(decodeURIComponent(parts[1]), subreddit)
      && parts[3].toLowerCase() === id.toLowerCase();
  } catch {
    return false;
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapPost(value: unknown): RedditPost | null {
  const post = record(value);
  if (!post) return null;
  const rawId = stringValue(post.id).trim().replace(/^t3_/i, '');
  const fullname = stringValue(post.fullname).trim() || (rawId ? `t3_${rawId}` : '');
  const title = stringValue(post.title);
  const permalink = redditPermalink(post.permalink);
  if (!rawId || fullname !== `t3_${rawId}` || !title || !permalink) return null;
  return {
    id: rawId,
    fullname,
    subreddit: stringValue(post.subreddit).trim(),
    title,
    author: stringValue(post.author),
    selfText: stringValue(post.selfText),
    url: stringValue(post.url).trim() || permalink,
    permalink,
    score: numberValue(post.score),
    comments: numberValue(post.comments),
    createdAt: isoDate(post.createdAt),
    nsfw: booleanValue(post.nsfw),
    spoiler: booleanValue(post.spoiler),
    isSelf: booleanValue(post.isSelf),
  };
}

export async function getRedditDevvitStatus(creds?: IntegrationCreds): Promise<RedditDevvitStatus> {
  const payload = await devvitRequest('status', {}, creds);
  const app = record(payload.app);
  const installation = record(payload.installation);
  const appSlug = stringValue(app?.slug).trim();
  const appAccount = stringValue(app?.account).trim();
  const appAccountId = stringValue(app?.accountId).trim() || undefined;
  const subreddit = responseSubreddit(installation?.subreddit);
  const subredditId = stringValue(installation?.subredditId).trim();
  if (payload.provider !== 'devvit' || !appSlug || !appAccount || !subreddit || !subredditId) {
    throw new Error('Reddit Devvit status response was incomplete');
  }
  const advertisedCapabilities = new Set(
    Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === 'string')
      : [],
  );
  if (!REQUIRED_CAPABILITIES.every((capability) => advertisedCapabilities.has(capability))) {
    throw new Error('Reddit Devvit bridge does not advertise the required read and submit capabilities');
  }
  return {
    ok: true,
    provider: 'devvit',
    protocolVersion: PROTOCOL_VERSION,
    appSlug,
    appAccount,
    appAccountId,
    subreddit,
    subredditId,
    capabilities: [...REQUIRED_CAPABILITIES],
  };
}

export async function testReddit(
  creds?: IntegrationCreds,
): Promise<RedditDevvitStatus | { ok: false; error: string }> {
  try {
    return await getRedditDevvitStatus(creds);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function redditReadPosts(
  input: RedditReadPostsInput = {},
  creds?: IntegrationCreds,
): Promise<RedditReadPostsResult> {
  const subreddit = input.subreddit?.trim() ? normalizeSubreddit(input.subreddit) : undefined;
  const sort = input.sort || 'hot';
  if (!SORTS.has(sort)) throw new Error(`Unsupported Reddit sort: ${String(sort)}`);
  if (input.time && !TIMES.has(input.time)) {
    throw new Error(`Unsupported Reddit time range: ${String(input.time)}`);
  }
  const numericLimit = Number(input.limit);
  const limit = Number.isFinite(numericLimit)
    ? Math.min(25, Math.max(1, Math.trunc(numericLimit)))
    : 10;
  const after = input.after?.trim();
  if (after && (after.length > 128 || !/^t3_[A-Za-z0-9]+$/.test(after))) {
    throw new Error('Invalid Reddit pagination cursor');
  }
  const payload = await devvitRequest('read', {
    ...(subreddit ? { subreddit } : {}),
    sort,
    ...(input.time && sort === 'top' ? { time: input.time } : {}),
    limit,
    ...(after ? { after } : {}),
  }, creds);
  if (!Array.isArray(payload.posts)) throw new Error('Reddit Devvit bridge returned an invalid post listing');
  const confirmedSubreddit = responseSubreddit(payload.subreddit);
  if (!confirmedSubreddit) {
    throw new Error('Reddit Devvit bridge returned an invalid listing community');
  }
  if (subreddit && !sameSubreddit(confirmedSubreddit, subreddit)) {
    throw new Error('Reddit Devvit bridge returned a listing for a different community');
  }
  const posts = payload.posts.map(mapPost).filter((post): post is RedditPost => post !== null);
  if (posts.length !== payload.posts.length) {
    throw new Error('Reddit Devvit bridge returned an invalid post record');
  }
  if (posts.some((post) => {
    const postSubreddit = responseSubreddit(post.subreddit);
    return !postSubreddit || !sameSubreddit(postSubreddit, confirmedSubreddit);
  })) {
    throw new Error('Reddit Devvit bridge returned a post outside the confirmed community');
  }
  const nextAfter = typeof payload.nextAfter === 'string' && /^t3_[A-Za-z0-9]+$/.test(payload.nextAfter)
    ? payload.nextAfter
    : null;
  return { posts, nextAfter };
}

export async function redditSubmit(
  input: RedditSubmitInput,
  creds?: IntegrationCreds,
): Promise<RedditSubmitResult> {
  const subreddit = normalizeSubreddit(input.subreddit);
  const title = input.title?.trim();
  if (!title) throw new Error('Reddit post title is required');
  if (title.length > 300) throw new Error('Reddit post title cannot exceed 300 characters');
  const kind = input.kind || 'self';
  if (kind !== 'self' && kind !== 'link') throw new Error(`Unsupported Reddit post kind: ${String(kind)}`);
  const text = input.text?.trim();
  const rawUrl = input.url?.trim();
  if (kind === 'link') {
    if (!rawUrl) throw new Error('A URL is required for a Reddit link post');
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Reddit link URL must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Reddit link URL must use http or https');
    }
    if (text) throw new Error('text is only valid for Reddit self posts');
  } else if (rawUrl) {
    throw new Error('url is only valid for Reddit link posts');
  }

  // Deliberately no retry: a lost response may follow a successful Reddit
  // write, so replaying could create a duplicate post.
  const payload = await devvitRequest('submit', {
    subreddit,
    title,
    kind,
    ...(kind === 'self' && text ? { text } : {}),
    ...(kind === 'link' && rawUrl ? { url: rawUrl } : {}),
    ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
    ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}),
    ...(input.sendReplies !== undefined ? { sendReplies: input.sendReplies } : {}),
  }, creds);
  const id = stringValue(payload.id).trim().replace(/^t3_/i, '');
  const fullname = stringValue(payload.fullname).trim();
  const url = redditPermalink(payload.url);
  const confirmedSubreddit = responseSubreddit(payload.subreddit);
  const confirmedTitle = stringValue(payload.title);
  if (!/^[A-Za-z0-9]+$/.test(id) || fullname !== `t3_${id}` || !url || !confirmedSubreddit || !confirmedTitle) {
    throw new Error('Reddit Devvit bridge did not return authoritative post confirmation');
  }
  if (!sameSubreddit(confirmedSubreddit, subreddit)) {
    throw new Error('Reddit Devvit bridge confirmed the post in a different community');
  }
  if (!permalinkMatchesPost(url, confirmedSubreddit, id)) {
    throw new Error('Reddit Devvit bridge returned a post permalink that does not match its confirmation');
  }
  return {
    ok: true,
    id,
    fullname,
    url,
    subreddit: confirmedSubreddit,
    title: confirmedTitle,
    author: stringValue(payload.author).trim() || undefined,
  };
}
