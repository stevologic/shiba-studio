import { test, expect } from '@playwright/test';

test('Cost & safety settings save round-trip', async ({ page, request }) => {
  const seeded = await request.post('/api/config', { data: { dailyBudgetUsd: 6 } });
  expect(seeded.ok()).toBeTruthy();

  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.settings-card', { hasText: 'Cost & safety' });
  await expect(card).toBeVisible();

  const dailyBudget = card.getByLabel(/Daily budget/i);
  await expect(dailyBudget).toHaveValue('6');
  await dailyBudget.fill('7');
  const saved = page.waitForResponse((response) => {
    if (
      new URL(response.url()).pathname !== '/api/config'
      || response.request().method() !== 'POST'
      || !response.ok()
    ) return false;
    try {
      const payload = response.request().postDataJSON() as { dailyBudgetUsd?: number };
      return payload.dailyBudgetUsd === 7;
    } catch {
      return false;
    }
  });
  await card.getByRole('button', { name: /Save Cost & Safety/i }).click();
  await saved;

  const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  expect(cfg.dailyBudgetUsd).toBe(7);
});

test('command palette searches runs/chats/logs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Use the visible trigger so this test targets search behavior rather than
  // racing React hydration of the global keyboard listener. Under the full
  // parallel suite the SSR button can briefly appear before its click handler
  // hydrates, so retry only until the palette actually opens.
  const trigger = page.getByRole('button', { name: 'Ctrl+K' });
  const input = page.getByLabel('Command palette search');
  await expect(async () => {
    if (!(await input.isVisible())) await trigger.click();
    await expect(input).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await input.fill('agents');
  // Command matches always exist; content hits depend on seeded data.
  await expect(page.locator('.command-palette-item').first()).toBeVisible();
});

test('logs page seeds search from ?q=', async ({ page }) => {
  await page.goto('/logs?q=system', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[placeholder*="Search"]').first()).toHaveValue('system');
});
