import { expect, test } from '@playwright/test';

test('shell and primary panels do not double-load the same resource', async ({ page }) => {
  // Other Playwright workers intentionally mutate the shared test server. Their
  // global SSE invalidations are valid reloads, but they are unrelated to this
  // test's initial-render accounting and would make the counts nondeterministic.
  await page.route('**/api/events', (route) => route.abort('blockedbyclient'));

  let requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith('/api/')) {
      requests.push(`${url.pathname}${url.search}`);
    }
  });

  const count = (url: string) => requests.filter((request) => request === url).length;
  const expectAtMostOnce = (urls: string[]) => {
    for (const url of urls) expect(count(url), `${url} request count`).toBeLessThanOrEqual(1);
  };

  await page.goto('/automations', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Automations', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(1_500);
  expectAtMostOnce([
    '/api/agents',
    '/api/boot',
    '/api/config',
    '/api/nav-stats',
    '/api/routines?limit=500',
    '/api/runs',
    '/api/runs?scheduledOnly=1&limit=200',
  ]);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(/\/board$/);
  await page.waitForTimeout(750);
  expectAtMostOnce(['/api/board', '/api/projects']);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: /Workspace/ }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.waitForTimeout(750);
  expectAtMostOnce(['/api/chat-sessions', '/api/workspace/sync']);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: 'Grok Chat', exact: true }).click();
  await expect(page).toHaveURL(/\/chat(?:\/|$)/);
  await page.waitForTimeout(1_000);
  expectAtMostOnce(['/api/chat-sessions', '/api/grok-cli/status', '/api/projects', '/api/tts']);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: 'Capabilities', exact: true }).click();
  await expect(page).toHaveURL(/\/integrations$/);
  await page.waitForTimeout(750);
  expectAtMostOnce(['/api/mcp', '/api/skills', '/api/tools']);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: 'Usage', exact: true }).click();
  await expect(page).toHaveURL(/\/usage$/);
  await page.waitForTimeout(750);
  expectAtMostOnce(['/api/usage']);

  requests = [];
  await page.locator('.sidebar').getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(page).toHaveURL(/\/logs$/);
  await page.waitForTimeout(750);
  expectAtMostOnce(['/api/agents', '/api/logs?limit=100&offset=0']);
});
