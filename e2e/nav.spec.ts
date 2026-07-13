import { test, expect } from '@playwright/test';

/** Every primary surface loads with zero console errors. */
const PAGES: Array<{ path: string; marker: string | RegExp }> = [
  { path: '/', marker: /Quick Stats|agent studio/i },
  { path: '/agents', marker: /Agents/ },
  { path: '/memories', marker: /Memories/ },
  { path: '/automations', marker: /Automations/ },
  { path: '/integrations', marker: /Capabilities/ },
  { path: '/usage', marker: /Usage/ },
  { path: '/logs', marker: /Logs/ },
  { path: '/settings', marker: /Settings/ },
  { path: '/projects', marker: /Projects/ },
  { path: '/workspace', marker: /Workspace/ },
  { path: '/board', marker: /Board/ },
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
