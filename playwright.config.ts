import { defineConfig } from '@playwright/test';

/**
 * Browser E2E suite (real UI, isolated data dir).
 *
 * One-time setup:  npx playwright install chromium
 * Run:             npm run test:e2e
 *
 * The webServer block builds nothing — run `npm run build` first (the suite
 * drives the production server, like scripts/verify-theme.ts does).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  // The suite intentionally shares one isolated Studio data directory. A
  // single CI worker keeps cross-file state changes deterministic.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3711',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx next start -H 127.0.0.1 -p 3711',
    url: 'http://127.0.0.1:3711',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      // Never touch the live ~/.shiba-studio store.
      SHIBA_DATA_DIR: process.env.SHIBA_E2E_DATA_DIR
        || `${process.env.TEMP || '/tmp'}/shiba-e2e-${Date.now()}`,
    },
  },
});
