import { Hono } from 'hono';

export const PROTOCOL_VERSION = 1;

const REDDIT_ORIGIN = 'https://www.reddit.com';
const SORTS = new Set(['hot', 'new', 'top', 'rising']);
const TIMEFRAMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

type DevvitServer = typeof import('@devvit/web/server');
type JsonObject = Record<string, unknown>;
type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export type BridgeContext = Pick<
  DevvitServer['context'],
  'appSlug' | 'subredditId' | 'subredditName'
>;

export type BridgeReddit = Pick<
  DevvitServer['reddit'],
  | 'getAppUser'
  | 'getHotPosts'
  | 'getNewPosts'
  | 'getPostById'
  | 'getRisingPosts'
  | 'getTopPosts'
  | 'submitPost'
>;

export interface BridgeDependencies {
  context: BridgeContext;
  reddit: BridgeReddit;
}

class InputError extends Error {}

function rejectInput(message: string): never {
  throw new InputError(message);
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function installedCommunity(context: BridgeContext): { name: string; id: string } {
  const name = context.subredditName?.trim();
  const id = context.subredditId?.trim();
  if (!name || !id) throw new Error('This endpoint must run in a subreddit installation');
  return { name, id };
}

function normalizeCommunity(value: unknown, installed: string): string {
  const requested = typeof value === 'string'
    ? value.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '')
    : '';
  if (!requested) return installed;
  if (!/^[A-Za-z0-9_]{1,21}$/.test(requested)) {
    rejectInput('subreddit must contain only letters, numbers, or underscores');
  }
  if (requested.toLowerCase() !== installed.toLowerCase()) {
    rejectInput(`This Devvit installation is scoped to r/${installed}`);
  }
  return installed;
}

function absoluteRedditUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `${REDDIT_ORIGIN}${text.startsWith('/') ? text : `/${text}`}`;
}

function postId(value: unknown): { id: string; fullname: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  const id = raw.replace(/^t3_/i, '');
  return { id, fullname: id ? `t3_${id}` : '' };
}

function isSelfPost(url: string, permalink: string, body: string): boolean {
  if (body) return true;
  if (!url) return true;
  try {
    const target = new URL(url, REDDIT_ORIGIN);
    const post = new URL(permalink, REDDIT_ORIGIN);
    return target.hostname.endsWith('reddit.com') && target.pathname === post.pathname;
  } catch {
    return false;
  }
}

function mapPost(post: Awaited<ReturnType<BridgeReddit['getPostById']>>) {
  const ids = postId(post.id);
  const permalink = absoluteRedditUrl(post.permalink);
  const url = absoluteRedditUrl(post.url) || permalink;
  const body = post.body || '';
  return {
    id: ids.id,
    fullname: ids.fullname,
    subreddit: post.subredditName,
    title: post.title,
    author: post.authorName,
    selfText: body,
    url,
    permalink,
    score: post.score,
    comments: post.numberOfComments,
    createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : undefined,
    nsfw: post.nsfw,
    spoiler: post.spoiler,
    isSelf: isSelfPost(url, permalink, body),
  };
}

async function requestBody(c: { req: { json<T>(): Promise<T> } }): Promise<JsonObject> {
  const value = await c.req.json<unknown>().catch(() => null);
  const body = object(value);
  if (!body) rejectInput('A JSON object request body is required');
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    rejectInput(`Unsupported Shiba bridge protocol: ${String(body.protocolVersion)}`);
  }
  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Devvit bridge error';
}

/**
 * Creates the HTTP contract independently from Devvit's process-level server.
 * Keeping this factory import-safe lets CI exercise every route with deterministic
 * fakes while the production entry point supplies the real Devvit context/client.
 */
export function createBridgeApp({ context, reddit }: BridgeDependencies): Hono {
  const app = new Hono();

  app.post('/external/shiba/status', async (c) => {
    try {
      await requestBody(c);
      const installation = installedCommunity(context);
      const appUser = await reddit.getAppUser();
      if (!appUser) throw new Error('Devvit did not return the app account');
      return c.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        provider: 'devvit',
        app: {
          slug: context.appSlug,
          account: appUser.username,
          accountId: appUser.id,
        },
        installation: {
          subreddit: installation.name,
          subredditId: installation.id,
        },
        capabilities: ['read_posts', 'submit_post'],
      });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, error instanceof InputError ? 400 : 500);
    }
  });

  app.post('/external/shiba/posts/read', async (c) => {
    try {
      const body = await requestBody(c);
      const installation = installedCommunity(context);
      const subreddit = normalizeCommunity(body.subreddit, installation.name);
      const sort = typeof body.sort === 'string' ? body.sort : 'hot';
      if (!SORTS.has(sort)) rejectInput(`Unsupported Reddit sort: ${sort}`);
      const timeframe = typeof body.time === 'string' ? body.time : undefined;
      if (timeframe && !TIMEFRAMES.has(timeframe)) {
        rejectInput(`Unsupported Reddit time range: ${timeframe}`);
      }
      const numericLimit = Number(body.limit);
      const limit = Number.isFinite(numericLimit)
        ? Math.min(25, Math.max(1, Math.trunc(numericLimit)))
        : 10;
      const after = typeof body.after === 'string' ? body.after.trim() : undefined;
      if (after && (after.length > 128 || !/^t3_[A-Za-z0-9]+$/.test(after))) {
        rejectInput('Invalid Reddit pagination cursor');
      }

      const options = {
        subredditName: subreddit,
        limit,
        pageSize: limit,
        ...(after ? { after } : {}),
      };
      const listing = sort === 'new'
        ? reddit.getNewPosts(options)
        : sort === 'top'
          ? reddit.getTopPosts({ ...options, timeframe: (timeframe || 'day') as Timeframe })
          : sort === 'rising'
            ? reddit.getRisingPosts(options)
            : reddit.getHotPosts(options);
      const posts = (await listing.all()).map(mapPost);
      return c.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        subreddit,
        posts,
        nextAfter: listing.hasMore ? posts.at(-1)?.fullname || null : null,
      });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, error instanceof InputError ? 400 : 502);
    }
  });

  app.post('/external/shiba/posts/submit', async (c) => {
    try {
      const body = await requestBody(c);
      const installation = installedCommunity(context);
      const subreddit = normalizeCommunity(body.subreddit, installation.name);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) rejectInput('Reddit post title is required');
      if (title.length > 300) rejectInput('Reddit post title cannot exceed 300 characters');
      const kind = body.kind === 'link'
        ? 'link'
        : body.kind === undefined || body.kind === 'self'
          ? 'self'
          : '';
      if (!kind) rejectInput(`Unsupported Reddit post kind: ${String(body.kind)}`);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
      if (kind === 'link') {
        if (!rawUrl) rejectInput('A URL is required for a Reddit link post');
        let url: URL;
        try {
          url = new URL(rawUrl);
        } catch {
          rejectInput('Reddit link URL must be a valid http(s) URL');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          rejectInput('Reddit link URL must use http or https');
        }
        if (text) rejectInput('text is only valid for Reddit self posts');
      } else if (rawUrl) {
        rejectInput('url is only valid for Reddit link posts');
      }

      const common = {
        subredditName: subreddit,
        title,
        runAs: 'APP' as const,
        nsfw: body.nsfw === true,
        spoiler: body.spoiler === true,
        sendreplies: body.sendReplies !== false,
      };
      const submitted = kind === 'link'
        ? await reddit.submitPost({ ...common, url: rawUrl })
        : await reddit.submitPost({ ...common, text });
      const ids = postId(submitted.id);
      const url = absoluteRedditUrl(submitted.permalink) || absoluteRedditUrl(submitted.url);
      if (!ids.id || !ids.fullname || !url) {
        throw new Error('Devvit did not return authoritative post confirmation');
      }
      return c.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        id: ids.id,
        fullname: ids.fullname,
        url,
        subreddit,
        title: submitted.title || title,
        author: submitted.authorName,
      });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, error instanceof InputError ? 400 : 502);
    }
  });

  return app;
}
