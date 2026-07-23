/**
 * Capture marketing screenshots for README + docs.
 * Requires a running server at BASE_URL (default http://127.0.0.1:3000).
 * Prefer `npm run build && npm run start` for clean frames (no Next dev indicator).
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'images');
const base = process.env.BASE_URL || 'http://127.0.0.1:3000';

const shots = [
  { file: 'dashboard.png', path: '/', alt: 'Dashboard', waitMs: 2800 },
  { file: 'chat.png', path: '/chat', alt: 'Grok Chat', waitMs: 3800 },
  { file: 'meetings.png', path: '/meetings', alt: 'Meetings', waitMs: 3200 },
  { file: 'board.png', path: '/board', alt: 'Board', waitMs: 3200 },
  { file: 'agents.png', path: '/agents', alt: 'Agents', waitMs: 3000 },
  { file: 'automations.png', path: '/automations', alt: 'Automations', waitMs: 3000 },
  { file: 'capabilities.png', path: '/integrations', alt: 'Capabilities', waitMs: 3000 },
  { file: 'projects.png', path: '/projects', alt: 'Projects', waitMs: 2500 },
  { file: 'workspace.png', path: '/workspace', alt: 'Workspace', waitMs: 2500 },
  { file: 'code.png', path: '/code', alt: 'Code IDE', waitMs: 3500 },
  { file: 'usage.png', path: '/usage', alt: 'Usage', waitMs: 3000 },
  { file: 'logs.png', path: '/logs', alt: 'Logs', waitMs: 3000 },
  { file: 'settings.png', path: '/settings', alt: 'Settings', waitMs: 3000 },
  { file: 'api-docs.png', path: '/api-docs', alt: 'API Explorer', waitMs: 2500 },
];

async function waitReady(page) {
  await page.waitForFunction(() => {
    const t = document.body?.innerText || '';
    return (
      t.includes('Shiba Studio')
      || t.includes('Grok Chat')
      || t.includes('Dashboard')
      || t.includes('API Explorer')
      || t.includes('Meetings')
      || t.includes('Board')
      || t.includes('Code')
    );
  }, { timeout: 60000 }).catch(() => {});
}

async function cleanChrome(page) {
  await page.evaluate(() => {
    document.querySelectorAll(
      '[data-sonner-toaster], .sonner-toast, nextjs-portal, [data-nextjs-toast], #__next-build-watcher',
    ).forEach((el) => {
      el.style.display = 'none';
    });
    // Next.js bottom-left "N" / turbopack indicator
    document.querySelectorAll('body > div').forEach((el) => {
      const s = getComputedStyle(el);
      if (s.position === 'fixed' && (s.bottom === '0px' || parseInt(s.bottom, 10) < 40) && parseInt(s.left, 10) < 40) {
        const r = el.getBoundingClientRect();
        if (r.width < 80 && r.height < 80) el.style.display = 'none';
      }
    });
  });
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

  // Warm the app once so first paints settle faster.
  try {
    await page.goto(`${base}/api/health`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    console.error(`Server not reachable at ${base}. Start with: npm run build && npm run start`);
    process.exit(1);
  }

  for (const shot of shots) {
    const url = `${base}${shot.path}`;
    console.log('capturing', url, '→', shot.file);
    // networkidle2 never settles while /api/events SSE stays open — use load + ready wait.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitReady(page);
    await new Promise((r) => setTimeout(r, shot.waitMs));
    await cleanChrome(page);
    const dest = path.join(outDir, shot.file);
    await page.screenshot({ path: dest, type: 'png', fullPage: false });
    const st = fs.statSync(dest);
    console.log('  wrote', dest, `(${st.size} bytes)`);
  }

  await browser.close();
  console.log('done —', shots.length, 'frames in', outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
