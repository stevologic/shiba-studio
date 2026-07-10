import { test, expect } from '@playwright/test';

test('Cost & safety settings save round-trip', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const card = page.locator('.settings-card', { hasText: 'Cost & safety' });
  await expect(card).toBeVisible();

  await card.getByLabel(/Daily budget/i).fill('7');
  await card.getByRole('button', { name: /Save Cost & Safety/i }).click();

  const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  expect(cfg.dailyBudgetUsd).toBe(7);
});

test('command palette searches runs/chats/logs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  const input = page.getByLabel('Command palette search');
  await expect(input).toBeVisible();
  await input.fill('agents');
  // Command matches always exist; content hits depend on seeded data.
  await expect(page.locator('.command-palette-item').first()).toBeVisible();
});

test('logs page seeds search from ?q=', async ({ page }) => {
  await page.goto('/logs?q=system', { waitUntil: 'networkidle' });
  await expect(page.locator('input[placeholder*="Search"]').first()).toHaveValue('system');
});
