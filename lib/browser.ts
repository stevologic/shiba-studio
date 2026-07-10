// Chrome / Browser control powered by Puppeteer for agents.
import { dataDir } from './data-paths';
// Provides navigate, click, type, screenshot, extract, scroll.

import puppeteer, { Browser, Page, type CDPSession } from 'puppeteer';

let browser: Browser | null = null;
const runPageMap = new Map<string, Page>();

/* ── Live screencast (sub-browser Interact mode) ── */
export type ScreencastFrame = {
  dataUrl: string;
  width: number;
  height: number;
  url: string;
  title: string;
  ts: number;
};

type FrameListener = (frame: ScreencastFrame) => void;

const screencastListeners = new Set<FrameListener>();
let screencastCdp: CDPSession | null = null;
let screencastRunId: string | null = null;
let lastScreencastFrame: ScreencastFrame | null = null;
let screencastStarting: Promise<void> | null = null;

/** The annotation sub-browser's persistent page. Chat-driven browser tools
 *  share it, so /annotate always shows what the agent is doing. */
export const SUBBROWSER_RUN_ID = '__subbrowser__';

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
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
    try {
      browser = await puppeteer.launch({ headless: true, args });
    } catch (e) {
      // Installs made with PUPPETEER_SKIP_DOWNLOAD=1 (documented opt-out to
      // save the ~150 MB Chromium pull) land here on first browser use.
      const msg = e instanceof Error ? e.message : String(e);
      if (/could not find|executable|browser was not found|cache path/i.test(msg)) {
        throw new Error(
          'Chromium is not installed for browser automation. Run `npx puppeteer browsers install chrome-headless-shell` '
          + '(or reinstall dependencies without PUPPETEER_SKIP_DOWNLOAD) and try again.',
        );
      }
      throw e;
    }
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
  } catch (e) {
    return { ok: false, selector, error: e instanceof Error ? e.message : String(e) };
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
  } catch {
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

/** Clear annotation highlights before live interact / new navigation. */
export async function browserClearHighlight(runId?: string): Promise<void> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  await page.evaluate(() => {
    document.querySelectorAll('[data-shiba-annotated]').forEach((prev) => {
      (prev as HTMLElement).style.outline = '';
      (prev as HTMLElement).style.outlineOffset = '';
      prev.removeAttribute('data-shiba-annotated');
    });
  }).catch(() => {});
}

export async function browserPageMeta(runId?: string): Promise<{ url: string; title: string; width: number; height: number }> {
  const page = runId ? await getPageForRun(runId) : await getPage();
  const viewport = page.viewport() || { width: 1280, height: 800 };
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    width: viewport.width,
    height: viewport.height,
  };
}

function emitScreencastFrame(frame: ScreencastFrame) {
  lastScreencastFrame = frame;
  for (const listener of screencastListeners) {
    try { listener(frame); } catch { /* ignore bad subscribers */ }
  }
}

/** Subscribe to live viewport frames. Call startScreencast separately (or ensure
 *  at least one subscriber starts it via browserEnsureScreencast). */
export function browserSubscribeScreencast(listener: FrameListener): () => void {
  screencastListeners.add(listener);
  if (lastScreencastFrame) {
    try { listener(lastScreencastFrame); } catch { /* */ }
  }
  return () => {
    screencastListeners.delete(listener);
    // Stop CDP stream when nobody is watching — saves CPU when modal closes.
    if (screencastListeners.size === 0) {
      void browserStopScreencast();
    }
  };
}

export function browserLastScreencastFrame(): ScreencastFrame | null {
  return lastScreencastFrame;
}

export async function browserEnsureScreencast(runId: string = SUBBROWSER_RUN_ID): Promise<void> {
  if (screencastCdp && screencastRunId === runId) return;
  if (screencastStarting) {
    await screencastStarting;
    return;
  }
  screencastStarting = browserStartScreencast(runId).finally(() => {
    screencastStarting = null;
  });
  await screencastStarting;
}

/** Start a continuous CDP screencast of the page viewport — powers Interact
 *  mode so the sub-browser feels like a real browser, not click-then-screenshot. */
export async function browserStartScreencast(runId: string = SUBBROWSER_RUN_ID): Promise<void> {
  if (screencastCdp && screencastRunId === runId) return;
  await browserStopScreencast();

  const page = await getPageForRun(runId);
  const viewport = page.viewport() || { width: 1280, height: 800 };
  const cdp = await page.createCDPSession();
  screencastCdp = cdp;
  screencastRunId = runId;

  cdp.on('Page.screencastFrame', async (event: {
    data: string;
    sessionId: number;
    metadata?: { deviceWidth?: number; deviceHeight?: number };
  }) => {
    try {
      const w = event.metadata?.deviceWidth || viewport.width;
      const h = event.metadata?.deviceHeight || viewport.height;
      let url = '';
      let title = '';
      try {
        url = page.url();
        title = await page.title().catch(() => '');
      } catch { /* page may be navigating */ }
      emitScreencastFrame({
        dataUrl: `data:image/jpeg;base64,${event.data}`,
        width: w,
        height: h,
        url,
        title,
        ts: Date.now(),
      });
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    } catch {
      try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }); } catch { /* */ }
    }
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 62,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });
}

export async function browserStopScreencast(): Promise<void> {
  const cdp = screencastCdp;
  screencastCdp = null;
  screencastRunId = null;
  if (!cdp) return;
  try {
    await cdp.send('Page.stopScreencast');
  } catch { /* already stopped */ }
  try {
    await cdp.detach();
  } catch { /* */ }
}

export type BrowserInputEvent =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown'; x: number; y: number; button?: number }
  | { kind: 'mouseup'; x: number; y: number; button?: number }
  | { kind: 'click'; x: number; y: number; button?: number; clickCount?: number }
  | { kind: 'dblclick'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaX?: number; deltaY?: number }
  | { kind: 'keydown'; key: string; code?: string; text?: string }
  | { kind: 'keyup'; key: string; code?: string }
  | { kind: 'type'; text: string };

/** Forward real pointer/keyboard events into the live page (viewport coords). */
export async function browserInput(event: BrowserInputEvent, runId: string = SUBBROWSER_RUN_ID): Promise<void> {
  const page = await getPageForRun(runId);
  const mouseButton = (btn?: number): 'left' | 'right' | 'middle' => {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  };

  switch (event.kind) {
    case 'mousemove':
      await page.mouse.move(event.x, event.y);
      break;
    case 'mousedown':
      await page.mouse.move(event.x, event.y);
      await page.mouse.down({ button: mouseButton(event.button) });
      break;
    case 'mouseup':
      await page.mouse.move(event.x, event.y);
      await page.mouse.up({ button: mouseButton(event.button) });
      break;
    case 'click':
      await page.mouse.click(event.x, event.y, {
        button: mouseButton(event.button),
        count: event.clickCount || 1,
      });
      break;
    case 'dblclick':
      await page.mouse.click(event.x, event.y, { count: 2 });
      break;
    case 'wheel':
      await page.mouse.move(event.x, event.y);
      await page.mouse.wheel({
        deltaX: event.deltaX || 0,
        deltaY: event.deltaY || 0,
      });
      break;
    case 'keydown': {
      // Printable characters → insert text; special keys → key events.
      const special = /^(Enter|Tab|Backspace|Delete|Escape|Arrow|Home|End|Page|F\d)/.test(event.key)
        || event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift';
      if (event.text && event.text.length >= 1 && !special) {
        await page.keyboard.sendCharacter(event.text);
      } else {
        await page.keyboard.down(event.key as Parameters<Page['keyboard']['down']>[0]);
      }
      break;
    }
    case 'keyup':
      try {
        await page.keyboard.up(event.key as Parameters<Page['keyboard']['up']>[0]);
      } catch { /* non-standard or already released */ }
      break;
    case 'type':
      await page.keyboard.type(event.text, { delay: 8 });
      break;
    default:
      break;
  }
}
