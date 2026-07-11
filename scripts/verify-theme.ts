/**
 * Theme verification: unit tests on shipped lib/theme.ts + headless UI launch.
 * Evidence written to goal scratch dir.
 */

import {
  THEME_COLORS,
  THEME_IDENTITY,
  RETIRED_ACCENT_HEX,
  isNearBlack,
  usesRetiredAccent,
} from '../lib/theme';
import * as fs from 'fs/promises';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';

import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import net from 'net';

/** Resolved to a genuinely free port before each launch — a fixed port
 *  collided with servers leaked by earlier runs (see killServerTree). */
let PORT = 0;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** child.kill() only kills the cmd.exe wrapper on Windows (shell: true) —
 *  the real node server survived and squatted the port for the NEXT run.
 *  taskkill /t takes down the whole tree. */
function killServerTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { shell: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function runThemeUnitTests(): Promise<void> {
  console.log('=== THEME UNIT TESTS (shipped lib/theme.ts) ===');

  const bgSurfaces = [THEME_COLORS.bg, THEME_COLORS.bgElev, THEME_COLORS.bgCard];
  for (const hex of bgSurfaces) {
    assert(isNearBlack(hex), `background ${hex} should be near-black`);
    console.log(`  OK near-black: ${hex}`);
  }

  const accentCandidates = [THEME_COLORS.accent, THEME_COLORS.accent2, THEME_COLORS.accent3];
  for (const hex of accentCandidates) {
    assert(!usesRetiredAccent(hex), `accent ${hex} must not be retired SaaS gradient color`);
    assert(!RETIRED_ACCENT_HEX.includes(hex.toLowerCase() as (typeof RETIRED_ACCENT_HEX)[number]), `accent ${hex} in retired list`);
    console.log(`  OK accent not retired: ${hex}`);
  }

  const identityBlob = JSON.stringify(THEME_IDENTITY).toLowerCase();
  assert(/grok|xai|spacex|x/.test(identityBlob), 'identity strings must reference Grok/xAI/SpaceX/X');
  console.log('  OK identity references Grok/xAI/SpaceX/X');

  console.log('=== THEME UNIT TESTS PASSED ===');
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server not ready at ${url} within ${timeoutMs}ms`);
}

function startProdServer(): ChildProcess {
  return spawn('npx', ['next', 'start', '--port', String(PORT)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
}

async function runHeadlessLaunch(runIndex: 1 | 2): Promise<{
  consoleErrors: string[];
  bodyBg: string;
  sidebarSnippet: string;
  heroSnippet: string;
  hasBranding: boolean;
  logoUsesRetiredGradient: boolean;
}> {
  const consoleErrors: string[] = [];
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(`http://localhost:${PORT}/?themeVerify=${runIndex}-${Date.now()}`, {
    // networkidle2, not 0: the shell keeps one SSE connection (/api/events)
    // open for live updates, so zero-in-flight never happens.
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const bodyBg = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    return bg;
  });

  const { sidebarSnippet, heroSnippet, hasBranding, logoUsesRetiredGradient } = await page.evaluate(() => {
    const sidebarHeader = document.querySelector('.sidebar');
    const heroCard = document.querySelector('.hero-eyebrow')?.closest('.grok-card');
    const logoImg = document.querySelector('.brand-logo') as HTMLElement | null;
    const logoGradient = logoImg
      ? getComputedStyle(logoImg).backgroundImage
      : '';
    const sidebarText = sidebarHeader?.textContent || '';
    const heroText = heroCard?.textContent || '';
    const branding = /grok|xai|spacex|x/i.test(sidebarText + heroText);
    const retiredGradient = /3b82f6|8b5cf6|22d3ee|linear-gradient/i.test(logoGradient);
    return {
      sidebarSnippet: sidebarHeader?.outerHTML?.slice(0, 2000) || '(missing sidebar)',
      heroSnippet: heroCard?.outerHTML?.slice(0, 2000) || '(missing hero)',
      hasBranding: branding,
      logoUsesRetiredGradient: retiredGradient,
    };
  });

  const shotPath = path.join(SCRATCH, `theme-launch-${runIndex}.png`);
  await page.screenshot({ path: shotPath, fullPage: false });
  console.log(`  Screenshot saved: ${shotPath}`);

  await browser.close();
  return { consoleErrors, bodyBg, sidebarSnippet, heroSnippet, hasBranding, logoUsesRetiredGradient };
}

async function runLaunchVerificationOnce(): Promise<void> {
  PORT = await getFreePort();
  const server = startProdServer();
  try {
    await waitForServer(`http://localhost:${PORT}`);
    console.log('  Server ready on port', PORT);

    const run1 = await runHeadlessLaunch(1);
    const run2 = await runHeadlessLaunch(2);

    for (const [label, run] of [['run1', run1], ['run2', run2]] as const) {
      assert(run.consoleErrors.length === 0, `${label} page console errors: ${run.consoleErrors.join('; ')}`);
      assert(run.hasBranding, `${label} sidebar/hero must contain SpaceX/X/Grok/xAI branding`);
      assert(!run.logoUsesRetiredGradient, `${label} logo must not use retired blue-purple-cyan gradient`);
      const rgb = run.bodyBg.match(/\d+/g)?.map(Number) || [0, 0, 0];
      const lum = 0.2126 * (rgb[0] / 255) + 0.7152 * (rgb[1] / 255) + 0.0722 * (rgb[2] / 255);
      assert(lum < 0.15, `${label} body background should be near-black, got ${run.bodyBg}`);
      console.log(`  OK ${label}: zero console errors, near-black body, branding present`);
    }

    const domSnippet = [
      '=== SIDEBAR HEADER ===',
      run1.sidebarSnippet,
      '',
      '=== DASHBOARD HERO ===',
      run1.heroSnippet,
    ].join('\n');
    await fs.writeFile(path.join(SCRATCH, 'theme-dom-snippet.txt'), domSnippet);
    console.log('  DOM snippet saved to theme-dom-snippet.txt');
  } finally {
    killServerTree(server);
  }
}

async function runLaunchVerification(): Promise<void> {
  console.log('=== THEME LAUNCH VERIFICATION (built app) ===');
  await fs.mkdir(SCRATCH, { recursive: true });

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`  Retrying launch verification (attempt ${attempt})...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await runLaunchVerificationOnce();
      console.log('=== THEME LAUNCH VERIFICATION PASSED ===');
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      await fs.writeFile(path.join(SCRATCH, `theme-launch-fallback-${attempt}.log`), msg);
      console.error(`  Launch attempt ${attempt} failed:`, msg);
    }
  }
  throw lastErr;
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });

  const logPath = path.join(SCRATCH, 'theme-unit.log');
  const logStream: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    logStream.push(line);
    origLog(...args);
  };
  try {
    await runThemeUnitTests();
  } finally {
    console.log = origLog;
  }
  await fs.writeFile(logPath, logStream.join('\n') + '\n');
  console.log('Theme unit log saved:', logPath);

  await runLaunchVerification();
  console.log('=== ALL THEME VERIFICATION COMPLETE ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('THEME VERIFY FAILED', e);
  process.exit(1);
});