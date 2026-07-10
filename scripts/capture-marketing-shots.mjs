/**
 * Capture marketing screenshots for README + GitHub Pages.
 * Requires a running dev server at BASE_URL (default http://localhost:3000).
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'images');
const base = process.env.BASE_URL || 'http://localhost:3000';

const shots = [
  { file: 'dashboard.png', path: '/', alt: 'Dashboard', waitMs: 2500 },
  { file: 'chat.png', path: '/chat', alt: 'Grok Chat', waitMs: 3500 },
  { file: 'agents.png', path: '/agents', alt: 'Agents', waitMs: 3000 },
  { file: 'automations.png', path: '/automations', alt: 'Automations', waitMs: 3000 },
  { file: 'capabilities.png', path: '/integrations', alt: 'Capabilities', waitMs: 3000 },
  { file: 'projects.png', path: '/projects', alt: 'Projects', waitMs: 2500 },
  { file: 'workspace.png', path: '/workspace', alt: 'Workspace', waitMs: 2500 },
  { file: 'usage.png', path: '/usage', alt: 'Usage', waitMs: 3000 },
  { file: 'logs.png', path: '/logs', alt: 'Logs', waitMs: 3000 },
  { file: 'settings.png', path: '/settings', alt: 'Settings', waitMs: 3000 },
  { file: 'api-docs.png', path: '/api-docs', alt: 'API Explorer', waitMs: 2500 },
];

async function waitReady(page) {
  await page.waitForFunction(() => {
    const t = document.body?.innerText || '';
    return t.includes('Shiba Studio') || t.includes('Grok Chat') || t.includes('Dashboard') || t.includes('API Explorer');
  }, { timeout: 60000 }).catch(() => {});
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  for (const shot of shots) {
    const url = `${base}${shot.path}`;
    console.log('capturing', url, '→', shot.file);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
    await waitReady(page);
    // Let client data (agents, sessions, stats) settle
    await new Promise((r) => setTimeout(r, shot.waitMs));
    // Hide toasts / Next.js dev indicator for cleaner marketing frames
    await page.evaluate(() => {
      document.querySelectorAll(
        '[data-sonner-toaster], .sonner-toast, nextjs-portal, [data-nextjs-toast], #__next-build-watcher',
      ).forEach((el) => {
        el.style.display = 'none';
      });
      // Next.js 13+ bottom-left "N" indicator
      document.querySelectorAll('body > div').forEach((el) => {
        const s = getComputedStyle(el);
        if (s.position === 'fixed' && (s.bottom === '0px' || parseInt(s.bottom, 10) < 40) && parseInt(s.left, 10) < 40) {
          const r = el.getBoundingClientRect();
          if (r.width < 80 && r.height < 80) el.style.display = 'none';
        }
      });
    });
    const dest = path.join(outDir, shot.file);
    await page.screenshot({ path: dest, type: 'png', fullPage: false });
    const st = fs.statSync(dest);
    console.log('  wrote', dest, `(${st.size} bytes)`);
  }

  await browser.close();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
