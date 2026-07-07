// Chrome / Browser control powered by Puppeteer for agents.
import { dataDir } from './data-paths';
// Provides navigate, click, type, screenshot, extract, scroll.

import puppeteer, { Browser, Page } from 'puppeteer';

let browser: Browser | null = null;
const runPageMap = new Map<string, Page>();

async function getBrowser(): Promise<Browser> {
  if (browser && (browser as any).connected) return browser;
  browser = await puppeteer.launch({
    headless: true, // set false for visible during debug on desktop
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
    ],
  });
  return browser;
}

/** Get (or create) a persistent page for a specific runId so that sequential actions (navigate then screenshot/click) share state. */
export async function getPageForRun(runId: string): Promise<Page> {
  const existing = runPageMap.get(runId);
  if (existing && !existing.isClosed()) return existing;
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  runPageMap.set(runId, page);
  return page;
}

export async function closeRunPage(runId: string) {
  const p = runPageMap.get(runId);
  if (p && !p.isClosed()) {
    await p.close().catch(() => {});
  }
  runPageMap.delete(runId);
}

export async function cleanupRunPages() {
  for (const [id, p] of Array.from(runPageMap.entries())) {
    if (p && !p.isClosed()) await p.close().catch(() => {});
    runPageMap.delete(id);
  }
}

export async function closeBrowser() {
  await cleanupRunPages();
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Back-compat for any non-run callers (will use a shared 'default' run page)
export async function getPage(): Promise<Page> {
  return getPageForRun('__default__');
}

export async function browserNavigate(url: string, runId?: string): Promise<{ ok: boolean; url: string; title?: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  const title = await page.title().catch(() => '');
  return { ok: true, url: page.url(), title };
}

export async function browserClick(selector: string, runId?: string): Promise<{ ok: boolean; selector: string; error?: string }> {
  try {
    const page = runId ? await getPageForRun(runId) : await getPage();
    await page.waitForSelector(selector, { timeout: 8000 });
    await page.click(selector);
    return { ok: true, selector };
  } catch (e: any) {
    return { ok: false, selector, error: e.message };
  }
}

export async function browserType(selector: string, text: string, submit = false, runId?: string): Promise<{ ok: boolean; selector: string; text: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  try {
    await page.waitForSelector(selector, { timeout: 8000 });
    await page.type(selector, text, { delay: 20 });
    if (submit) {
      await page.keyboard.press('Enter');
    }
    return { ok: true, selector, text };
  } catch (e: any) {
    // fallback direct
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (el) el.value = val;
    }, selector, text);
    if (submit) await page.keyboard.press('Enter');
    return { ok: true, selector, text };
  }
}

export async function browserScreenshot(name = 'capture', runId?: string): Promise<{ ok: boolean; path: string; dataUrl?: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const { ensureDir } = await import('./workspace');
  const pathMod = await import('path');
  const { writeFile } = await import('fs/promises');
  const shotsDir = dataDir('screenshots');
  await ensureDir(shotsDir);
  const file = pathMod.join(shotsDir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // Also return small data url for UI
  const buf = await page.screenshot({ encoding: 'base64', fullPage: false, clip: { x: 0, y: 0, width: 960, height: 540 } });
  const dataUrl = `data:image/png;base64,${buf}`;
  return { ok: true, path: file, dataUrl };
}

export async function browserExtractText(selector?: string, runId?: string): Promise<string> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  if (selector) {
    return page.$$eval(selector, els => els.map(e => (e as HTMLElement).innerText || '').join('\n')).catch(() => '');
  }
  return page.evaluate(() => document.body.innerText || '').catch(() => '');
}

export async function browserScroll(direction: 'down' | 'up' | 'top' | 'bottom' = 'down', runId?: string): Promise<{ ok: true; dir: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  if (direction === 'down') await page.evaluate(() => window.scrollBy(0, 600));
  else if (direction === 'up') await page.evaluate(() => window.scrollBy(0, -600));
  else if (direction === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  else await page.evaluate(() => window.scrollTo(0, 0));
  return { ok: true, dir: direction };
}

export async function browserGetUrl(runId?: string): Promise<string> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  return page.url();
}

/* ── Sub-browser: annotate live pages and feed elements into chat ── */

export interface InspectedElement {
  selector: string;
  tag: string;
  id?: string;
  className?: string;
  rect: { x: number; y: number; width: number; height: number };
  outerHTML: string;
  text: string;
}

/** Full current-viewport screenshot at natural size, with dimensions for
 *  client-side coordinate mapping. */
export async function browserViewportShot(runId?: string): Promise<{ dataUrl: string; width: number; height: number; url: string; title: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const viewport = page.viewport() || { width: 1280, height: 800 };
  const buf = await page.screenshot({ encoding: 'base64', fullPage: false });
  return {
    dataUrl: `data:image/png;base64,${buf}`,
    width: viewport.width,
    height: viewport.height,
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/** DevTools-style pick: the deepest element at viewport coordinates, with a
 *  stable selector and an HTML excerpt for prompting. */
export async function browserInspectAt(x: number, y: number, runId?: string): Promise<InspectedElement | null> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  return page.evaluate(({ px, py }) => {
    const el = document.elementFromPoint(px, py) as HTMLElement | null;
    if (!el) return null;

    const cssEscape = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    const buildSelector = (start: Element): string => {
      const parts: string[] = [];
      let node: Element | null = start;
      for (let depth = 0; node && node !== document.documentElement && depth < 6; depth++) {
        if ((node as HTMLElement).id) {
          parts.unshift(`#${cssEscape((node as HTMLElement).id)}`);
          break;
        }
        let part = node.tagName.toLowerCase();
        const cls = typeof (node as HTMLElement).className === 'string'
          ? (node as HTMLElement).className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
          : [];
        if (cls.length) part += `.${cls.map(cssEscape).join('.')}`;
        const parentEl: Element | null = node.parentElement;
        if (parentEl) {
          const siblings = Array.from(parentEl.children).filter((c) => c.tagName === node!.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parentEl;
      }
      return parts.join(' > ');
    };

    const r = el.getBoundingClientRect();
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: typeof el.className === 'string' && el.className.trim() ? el.className.trim() : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      outerHTML: el.outerHTML.slice(0, 4000),
      text: ((el as HTMLElement).innerText || '').slice(0, 400),
    };
  }, { px: x, py: y });
}

/** Forward a real click at viewport coordinates — lets the sub-browser's
 *  Interact mode click links/buttons and navigate like a normal browser. */
export async function browserClickAt(x: number, y: number, runId?: string): Promise<void> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  await page.mouse.click(x, y);
  // Give any resulting navigation/render a moment to settle.
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
}

/** Outline one element (orange) so annotated screenshots show the selection. */
export async function browserHighlight(selector: string, runId?: string): Promise<boolean> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  return page.evaluate((sel) => {
    document.querySelectorAll('[data-shiba-annotated]').forEach((prev) => {
      (prev as HTMLElement).style.outline = '';
      (prev as HTMLElement).style.outlineOffset = '';
      prev.removeAttribute('data-shiba-annotated');
    });
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.style.outline = '3px solid #f97316';
    el.style.outlineOffset = '2px';
    el.setAttribute('data-shiba-annotated', '1');
    return true;
  }, selector).catch(() => false);
}
