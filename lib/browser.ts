// Chrome / Browser control powered by Puppeteer for agents.
import { dataDir } from './data-paths';
// Provides navigate, click, type, screenshot, extract, scroll.

import puppeteer, { Browser, Page } from 'puppeteer';

let browser: Browser | null = null;
const runPageMap = new Map<string, Page>();

/** The annotation sub-browser's persistent page. Chat-driven browser tools
 *  share it, so /annotate always shows what the agent is doing. */
export const SUBBROWSER_RUN_ID = '__subbrowser__';

async function getBrowser(): Promise<Browser> {
  if (browser && (browser as any).connected) return browser;
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
  ];
  // `headless: 'shell'` uses chrome-headless-shell — genuinely windowless, so
  // no Chrome window flashes on screen (the newer `headless: true` launches a
  // real Chrome that can pop a visible window on Windows). Fall back to the
  // standard headless mode if the shell binary isn't present.
  try {
    browser = await puppeteer.launch({ headless: 'shell', args });
  } catch {
    browser = await puppeteer.launch({ headless: true, args });
  }
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

/** Whole-page screenshot (height-capped) — the sub-browser renders it as one
 *  tall image, so scrolling is native and instant on the client with zero
 *  round-trips. JPEG keeps long pages shippable. */
export async function browserFullShot(runId?: string): Promise<{ dataUrl: string; width: number; height: number; url: string; title: string }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const viewport = page.viewport() || { width: 1280, height: 800 };
  const fullHeight = await page.evaluate(() => Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0,
    window.innerHeight,
  )).catch(() => viewport.height);
  const height = Math.min(Math.max(fullHeight, viewport.height), 6000);
  const buf = await page.screenshot({
    encoding: 'base64',
    type: 'jpeg',
    quality: 72,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: viewport.width, height },
  });
  return {
    dataUrl: `data:image/jpeg;base64,${buf}`,
    width: viewport.width,
    height,
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/** Scroll the real page so a full-page Y coordinate is on screen; returns the
 *  matching viewport Y for elementFromPoint / mouse events. behavior:'instant'
 *  overrides any CSS scroll-behavior:smooth — a smooth scroll would still be
 *  animating when scrollY is read back, throwing the coordinate off screen. */
async function alignFullCoord(page: Page, yFull: number): Promise<number> {
  return page.evaluate((y) => {
    window.scrollTo({ top: Math.max(0, y - window.innerHeight / 2), left: 0, behavior: 'instant' as ScrollBehavior });
    return y - (window.scrollY ?? window.pageYOffset ?? 0);
  }, yFull);
}

/** DevTools-style pick addressed in FULL-PAGE coordinates (from the tall shot). */
export async function browserInspectAtFull(x: number, yFull: number, runId?: string): Promise<InspectedElement | null> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const vy = await alignFullCoord(page, yFull);
  return browserInspectAt(x, Math.round(vy), runId);
}

/** Forward a real click addressed in FULL-PAGE coordinates. */
export async function browserClickAtFull(x: number, yFull: number, runId?: string): Promise<void> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const vy = await alignFullCoord(page, yFull);
  await page.mouse.click(x, Math.max(0, Math.round(vy)));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
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

/** Scroll the page by a pixel delta — powers the sub-browser's mouse wheel. */
export async function browserScrollBy(pixels: number, runId?: string): Promise<void> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  await page.evaluate((dy) => window.scrollBy(0, dy), pixels);
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
