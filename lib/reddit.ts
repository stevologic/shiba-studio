/**
 * Reddit Data API client.
 *
 * Authentication and access-token refresh are owned by reddit-oauth.ts. Reads
 * may retry once after a definitive 401; submissions deliberately never retry
 * because an interrupted POST may already have created the post.
 */

import type { IntegrationCreds } from './types';
import { redditOAuthFetch } from './reddit-oauth';

export type RedditPostSort = 'hot' | 'new' | 'top' | 'rising';
export type RedditPostTime = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditReadPostsInput {
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
}

type JsonRecord = Record<string, unknown>;

const SORTS = new Set<RedditPostSort>(['hot', 'new', 'top', 'rising']);
const TIMES = new Set<RedditPostTime>(['hour', 'day', 'week', 'month', 'year', 'all']);
const REDDIT_ORIGIN = 'https://www.reddit.com';

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
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Accept `foo`, `r/foo`, `/r/foo/`, or a reddit.com `/r/foo` URL. */
function normalizeSubreddit(value: string): string {
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

function normalizePermalink(value: unknown): string {
  const path = stringValue(value).trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${REDDIT_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

function createdAt(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function readPayload(res: Response): Promise<{ payload?: unknown; text: string }> {
  const text = await res.text();
  if (!text) return { text: '' };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { text };
  }
}

function describeApiError(payload: unknown, fallback: string): string {
  const root = record(payload);
  const nestedError = record(root?.error);
  const message = nestedError?.message
    ?? root?.message
    ?? root?.error_description
    ?? (typeof root?.error === 'string' ? root.error : undefined);
  if (message) return stringValue(message).slice(0, 500);
  return fallback.slice(0, 500);
}

function formatSubmitErrors(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages = value.map((entry) => {
    if (!Array.isArray(entry)) return stringValue(entry);
    const [code, message, field] = entry;
    const detail = stringValue(message) || stringValue(code) || 'Reddit rejected the post';
    const fieldName = stringValue(field);
    return fieldName ? `${detail} (${fieldName})` : detail;
  }).filter(Boolean);
  return messages.join('; ').slice(0, 800) || 'Reddit rejected the post';
}

function mapPost(value: unknown): RedditPost | null {
  const post = record(value);
  if (!post) return null;
  const id = stringValue(post.id).trim();
  const title = stringValue(post.title);
  if (!id || !title) return null;

  const rawUrl = stringValue(post.url).trim();
  const permalink = normalizePermalink(post.permalink);
  return {
    id,
    fullname: stringValue(post.name).trim() || `t3_${id}`,
    subreddit: stringValue(post.subreddit),
    title,
    author: stringValue(post.author),
    selfText: stringValue(post.selftext),
    url: rawUrl || permalink,
    permalink,
    score: numberValue(post.score),
    comments: numberValue(post.num_comments),
    createdAt: createdAt(post.created_utc),
    nsfw: booleanValue(post.over_18),
    spoiler: booleanValue(post.spoiler),
    isSelf: booleanValue(post.is_self),
  };
}

export async function testReddit(
  creds?: IntegrationCreds,
): Promise<{ ok: boolean; username?: string; id?: string; error?: string }> {
  try {
    const res = await redditOAuthFetch('/api/v1/me', {
      method: 'GET',
      retryUnauthorized: true,
    }, creds);
    const { payload, text } = await readPayload(res);
    if (!res.ok) {
      return {
        ok: false,
        error: `Reddit API ${res.status}: ${describeApiError(payload, text || res.statusText)}`,
      };
    }
    const me = record(payload);
    if (!me) return { ok: false, error: 'Reddit API returned an invalid identity response' };
    const username = stringValue(me.name).trim();
    const id = stringValue(me.id).trim();
    if (!username || !id) {
      return { ok: false, error: 'Reddit identity response did not include a username and user id' };
    }
    return { ok: true, username, id };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function redditReadPosts(
  input: RedditReadPostsInput = {},
  creds?: IntegrationCreds,
): Promise<RedditReadPostsResult> {
  const requestedSubreddit = input.subreddit?.trim();
  const subreddit = requestedSubreddit ? normalizeSubreddit(requestedSubreddit) : undefined;
  const sort = input.sort || 'hot';
  if (!SORTS.has(sort)) throw new Error(`Unsupported Reddit sort: ${String(sort)}`);
  if (input.time && !TIMES.has(input.time)) {
    throw new Error(`Unsupported Reddit time range: ${String(input.time)}`);
  }

  const requestedLimit = Number(input.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(25, Math.max(1, Math.trunc(requestedLimit)))
    : 10;
  const query = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (input.time && sort === 'top') query.set('t', input.time);
  const after = input.after?.trim();
  if (after) {
    if (after.length > 128) throw new Error('Reddit pagination cursor is too long');
    query.set('after', after);
  }

  const listingPath = subreddit
    ? `/r/${encodeURIComponent(subreddit)}/${sort}`
    : `/${sort}`;
  const res = await redditOAuthFetch(
    `${listingPath}?${query.toString()}`,
    { method: 'GET', retryUnauthorized: true },
    creds,
  );
  const { payload, text } = await readPayload(res);
  if (!res.ok) {
    throw new Error(`Reddit API ${res.status}: ${describeApiError(payload, text || res.statusText)}`);
  }

  const listing = record(payload);
  const data = record(listing?.data);
  if (!data || !Array.isArray(data.children)) {
    throw new Error('Reddit API returned an invalid post listing');
  }
  const posts = data.children
    .map((child) => mapPost(record(child)?.data))
    .filter((post): post is RedditPost => post !== null);
  const nextAfter = typeof data.after === 'string' && data.after.trim()
    ? data.after.trim()
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

  const body = new URLSearchParams({
    api_type: 'json',
    raw_json: '1',
    sr: subreddit,
    kind,
    title,
    sendreplies: String(input.sendReplies !== false),
  });
  if (kind === 'self' && text) body.set('text', text);
  if (kind === 'link' && rawUrl) body.set('url', rawUrl);
  if (input.nsfw !== undefined) body.set('nsfw', String(input.nsfw));
  if (input.spoiler !== undefined) body.set('spoiler', String(input.spoiler));

  const res = await redditOAuthFetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    retryUnauthorized: false,
  }, creds);
  const { payload, text: responseText } = await readPayload(res);
  if (!res.ok) {
    throw new Error(
      `Reddit submit ${res.status}: ${describeApiError(payload, responseText || res.statusText)}`,
    );
  }

  const root = record(payload);
  const json = record(root?.json);
  if (!json) throw new Error('Reddit submit returned an invalid response');
  const submissionErrors = formatSubmitErrors(json.errors);
  if (submissionErrors) throw new Error(`Reddit rejected the post: ${submissionErrors}`);

  const data = record(json.data);
  const id = stringValue(data?.id).trim();
  const fullname = stringValue(data?.name).trim();
  const authoritativeUrl = stringValue(data?.url).trim();
  if (!id || !fullname || !authoritativeUrl) {
    throw new Error('Reddit did not return authoritative post confirmation (id, fullname, and url)');
  }

  return {
    ok: true,
    id,
    fullname,
    url: authoritativeUrl,
    subreddit,
    title,
  };
}
