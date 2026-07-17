import { test, expect } from '@playwright/test';

/** Every primary surface loads with zero console errors. */
const PAGES: Array<{ path: string; marker: string | RegExp }> = [
  { path: '/', marker: /Quick Stats|agent studio/i },
  { path: '/attention', marker: /Attention/i },
  { path: '/chat', marker: /Grok Chat|New chat/i },
  { path: '/agents', marker: /Agents/ },
  { path: '/memories', marker: /Memories/ },
  { path: '/automations', marker: /Automations/ },
  { path: '/integrations', marker: /Capabilities/ },
  { path: '/usage', marker: /Usage/ },
  { path: '/logs', marker: /Logs/ },
  { path: '/settings', marker: /Settings/ },
  { path: '/projects', marker: /Projects/ },
  { path: '/workspace', marker: /Workspace/ },
  { path: '/code', marker: /Code|Explorer/i },
  { path: '/files', marker: /Files/ },
  { path: '/board', marker: /Board/ },
  { path: '/companion', marker: /Companion/i },
];

for (const { path: pagePath, marker } of PAGES) {
  test(`page ${pagePath} renders without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    // The app intentionally keeps /api/events open for live updates, so
    // Playwright's networkidle condition can never become true.
    await page.goto(pagePath, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toContainText(marker);
    expect(errors, `console errors on ${pagePath}: ${errors.join('; ')}`).toHaveLength(0);
  });
}

test('primary navigation keeps the simplified product surface', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const sidebar = page.locator('.sidebar');

  await expect(sidebar.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('href', '/');
  await expect(sidebar.getByRole('link', { name: 'Code', exact: true })).toHaveAttribute('href', '/code');
  await expect(sidebar.getByRole('link', { name: 'Automations', exact: true })).toHaveAttribute('href', '/automations');

  for (const retiredLabel of ['Dispatch', 'Routines', 'Meetings', 'Doctor']) {
    await expect(sidebar.getByRole('link', { name: retiredLabel, exact: true })).toHaveCount(0);
  }
});

for (const retiredPath of ['/meetings', '/doctor']) {
  test(`retired surface ${retiredPath} is not directly reachable`, async ({ page }) => {
    const response = await page.goto(retiredPath, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(404);
    await expect(page.getByText('That Shiba Studio page does not exist')).toBeVisible();
  });
}

test('Files explorer navigates folders and previews a tracked file', async ({ page }) => {
  const createdAt = '2026-07-13T12:00:00.000Z';
  await page.route('**/api/files**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('inspect') === '1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          binary: false,
          truncated: false,
          content: '# Release notes\n\nReady to ship.',
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        files: [
          {
            name: 'release.md',
            relPath: 'docs/reports/release.md',
            absPath: 'C:\\workspace\\docs\\reports\\release.md',
            size: 31,
            mtime: createdAt,
            kind: 'text',
            preview: '# Release notes',
            agentName: 'Release Shiba',
            createdAt,
          },
          {
            name: 'plan.txt',
            relPath: 'docs/plan.txt',
            absPath: 'C:\\workspace\\docs\\plan.txt',
            size: 12,
            mtime: createdAt,
            kind: 'text',
            preview: 'Plan',
            agentName: 'Release Shiba',
            createdAt,
          },
        ],
      }),
    });
  });

  await page.goto('/files', { waitUntil: 'domcontentloaded' });
  const explorer = page.locator('aside[aria-label="Files explorer"]');
  const breadcrumb = page.locator('nav[aria-label="File breadcrumb"]');
  await expect(explorer).toBeVisible();
  await expect(breadcrumb).toBeVisible();

  await explorer.getByRole('button', { name: /^docs\b/ }).click();
  await expect(breadcrumb).toContainText('docs');
  await explorer.getByRole('button', { name: /^reports\b/ }).click();
  await expect(breadcrumb).toContainText('reports');
  await explorer.getByRole('button', { name: /^release\.md\b/ }).click();

  const preview = page.locator('section[aria-label="File preview"]');
  await expect(preview).toContainText('release.md');
  await expect(preview).toContainText('Ready to ship.');
});

test('sidebar navigation reaches Settings', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.locator('body')).toContainText('Agent Behavior');
});

test('unknown app routes return the real 404 boundary', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-shiba-route', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(404);
  await expect(page.getByText('That Shiba Studio page does not exist')).toBeVisible();
});

test('X MCP preset exposes automatic browser sign-in safely', async ({ page }) => {
  await page.goto('/integrations', { waitUntil: 'domcontentloaded' });
  const xCard = page.getByRole('button', { name: /X \(Twitter\).*official X API MCP bridge/i });
  await expect(xCard).toBeVisible();
  const presetContainer = xCard.locator('..');
  await presetContainer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('http://localhost:8080/callback', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add & sign in with X' })).toBeVisible();
  await expect(page.getByPlaceholder('OAuth 2.0 Client Secret')).toHaveAttribute('type', 'password');
});
