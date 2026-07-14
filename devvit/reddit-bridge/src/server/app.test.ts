import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createBridgeApp,
  PROTOCOL_VERSION,
  type BridgeContext,
  type BridgeReddit,
} from './app.ts';

const installedContext: BridgeContext = {
  appSlug: 'shiba-rdt-bridge',
  subredditId: 't5_shiba',
  subredditName: 'ShibaStudio',
};

const samplePost = {
  id: 't3_abc123',
  permalink: '/r/ShibaStudio/comments/abc123/a_post/',
  url: '/r/ShibaStudio/comments/abc123/a_post/',
  body: 'A useful thought',
  subredditName: 'ShibaStudio',
  title: 'A post',
  authorName: 'devvit-app',
  score: 42,
  numberOfComments: 7,
  createdAt: new Date('2026-07-13T12:00:00.000Z'),
  nsfw: false,
  spoiler: false,
};

function listing(posts = [samplePost], hasMore = false) {
  return {
    all: async () => posts,
    hasMore,
  };
}

function fakeReddit(overrides: Record<string, unknown> = {}): BridgeReddit {
  return {
    getAppUser: async () => ({ id: 't2_app', username: 'shiba-app' }),
    getHotPosts: () => listing(),
    getNewPosts: () => listing(),
    getPostById: async () => samplePost,
    getRisingPosts: () => listing(),
    getTopPosts: () => listing(),
    submitPost: async () => samplePost,
    ...overrides,
  } as unknown as BridgeReddit;
}

async function post(
  path: string,
  body: unknown,
  dependencies: { context?: BridgeContext; reddit?: BridgeReddit } = {},
) {
  const app = createBridgeApp({
    context: dependencies.context || installedContext,
    reddit: dependencies.reddit || fakeReddit(),
  });
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('status reports the Devvit app identity, installation, and capabilities', async () => {
  const response = await post('/external/shiba/status', { protocolVersion: PROTOCOL_VERSION });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result, {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    provider: 'devvit',
    app: {
      slug: 'shiba-rdt-bridge',
      account: 'shiba-app',
      accountId: 't2_app',
    },
    installation: {
      subreddit: 'ShibaStudio',
      subredditId: 't5_shiba',
    },
    capabilities: ['read_posts', 'submit_post'],
  });
});

test('all routes reject missing or unsupported protocol versions before doing work', async () => {
  let calls = 0;
  const reddit = fakeReddit({
    getAppUser: async () => {
      calls += 1;
      return { id: 't2_app', username: 'shiba-app' };
    },
    getHotPosts: () => {
      calls += 1;
      return listing();
    },
    submitPost: async () => {
      calls += 1;
      return samplePost;
    },
  });

  for (const path of [
    '/external/shiba/status',
    '/external/shiba/posts/read',
    '/external/shiba/posts/submit',
  ]) {
    const response = await post(path, {}, { reddit });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.error, /Unsupported Shiba bridge protocol/);
  }
  assert.equal(calls, 0);
});

test('read maps Reddit posts, clamps page size, and returns the authoritative cursor', async () => {
  let options: unknown;
  const reddit = fakeReddit({
    getTopPosts: (value: unknown) => {
      options = value;
      return listing([samplePost], true);
    },
  });
  const response = await post('/external/shiba/posts/read', {
    protocolVersion: PROTOCOL_VERSION,
    subreddit: '/r/shibastudio/',
    sort: 'top',
    time: 'week',
    limit: 900,
    after: 't3_previous',
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(options, {
    subredditName: 'ShibaStudio',
    limit: 25,
    pageSize: 25,
    after: 't3_previous',
    timeframe: 'week',
  });
  assert.equal(result.nextAfter, 't3_abc123');
  assert.deepEqual(result.posts, [{
    id: 'abc123',
    fullname: 't3_abc123',
    subreddit: 'ShibaStudio',
    title: 'A post',
    author: 'devvit-app',
    selfText: 'A useful thought',
    url: 'https://www.reddit.com/r/ShibaStudio/comments/abc123/a_post/',
    permalink: 'https://www.reddit.com/r/ShibaStudio/comments/abc123/a_post/',
    score: 42,
    comments: 7,
    createdAt: '2026-07-13T12:00:00.000Z',
    nsfw: false,
    spoiler: false,
    isSelf: true,
  }]);
});

test('read cannot escape the subreddit installation', async () => {
  let called = false;
  const reddit = fakeReddit({
    getHotPosts: () => {
      called = true;
      return listing();
    },
  });
  const response = await post('/external/shiba/posts/read', {
    protocolVersion: PROTOCOL_VERSION,
    subreddit: 'another_subreddit',
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(result.error, /scoped to r\/ShibaStudio/);
});

test('read rejects malformed pagination cursors', async () => {
  const response = await post('/external/shiba/posts/read', {
    protocolVersion: PROTOCOL_VERSION,
    after: 'abc123',
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.error, 'Invalid Reddit pagination cursor');
});

test('read translates a Devvit listing failure into a bridge error', async () => {
  const reddit = fakeReddit({
    getHotPosts: () => ({
      all: async () => {
        throw new Error('Reddit unavailable');
      },
      hasMore: false,
    }),
  });
  const response = await post('/external/shiba/posts/read', {
    protocolVersion: PROTOCOL_VERSION,
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.error, 'Reddit unavailable');
});

test('submit sends self posts as the app and returns authoritative confirmation', async () => {
  let options: unknown;
  const reddit = fakeReddit({
    submitPost: async (value: unknown) => {
      options = value;
      return {
        ...samplePost,
        id: 'newpost',
        permalink: '/r/ShibaStudio/comments/newpost/a_new_post/',
        title: 'A new post',
      };
    },
  });
  const response = await post('/external/shiba/posts/submit', {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'self',
    title: '  A new post  ',
    text: '  The body  ',
    nsfw: true,
    spoiler: true,
    sendReplies: false,
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(options, {
    subredditName: 'ShibaStudio',
    title: 'A new post',
    runAs: 'APP',
    nsfw: true,
    spoiler: true,
    sendreplies: false,
    text: 'The body',
  });
  assert.deepEqual(result, {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    id: 'newpost',
    fullname: 't3_newpost',
    url: 'https://www.reddit.com/r/ShibaStudio/comments/newpost/a_new_post/',
    subreddit: 'ShibaStudio',
    title: 'A new post',
    author: 'devvit-app',
  });
});

test('submit rejects unsafe link schemes without calling Reddit', async () => {
  let called = false;
  const reddit = fakeReddit({
    submitPost: async () => {
      called = true;
      return samplePost;
    },
  });
  const response = await post('/external/shiba/posts/submit', {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'link',
    title: 'Not allowed',
    url: 'ftp://example.com/file',
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.equal(result.error, 'Reddit link URL must use http or https');
});

test('submit fails closed when Devvit omits authoritative confirmation', async () => {
  const reddit = fakeReddit({
    submitPost: async () => ({
      ...samplePost,
      id: '',
      permalink: '',
      url: '',
    }),
  });
  const response = await post('/external/shiba/posts/submit', {
    protocolVersion: PROTOCOL_VERSION,
    title: 'No confirmation',
  }, { reddit });
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.error, 'Devvit did not return authoritative post confirmation');
});
