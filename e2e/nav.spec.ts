import { test, expect } from '@playwright/test';

/** Every primary surface loads with zero console errors. */
const PAGES: Array<{ path: string; marker: string | RegExp }> = [
  { path: '/', marker: /Quick Stats|agent studio/i },
  { path: '/agents', marker: /Agents/ },
  { path: '/automations', marker: /Automations/ },
  { path: '/integrations', marker: /Capabilities/ },
  { path: '/usage', marker: /Usage/ },
  { path: '/logs', marker: /Logs/ },
  { path: '/settings', marker: /Settings/ },
  { path: '/projects', marker: /Projects/ },
  { path: '/workspace', marker: /Workspace/ },
];

for (const { path: pagePath, marker } of PAGES) {
  test(`page ${pagePath} renders without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto(pagePath, { waitUntil: 'networkidle' });
    await expect(page.locator('body')).toContainText(marker);
    expect(errors, `console errors on ${pagePath}: ${errors.join('; ')}`).toHaveLength(0);
  });
}

test('sidebar navigation reaches Settings', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.locator('body')).toContainText('Agent Behavior');
});
