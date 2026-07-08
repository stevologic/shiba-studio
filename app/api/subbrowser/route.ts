import { NextRequest, NextResponse } from 'next/server';
import {
  browserClearHighlight,
  browserClickAtFull,
  browserEnsureScreencast,
  browserFullShot,
  browserHighlight,
  browserInput,
  browserInspectAt,
  browserInspectAtFull,
  browserNavigate,
  browserPageMeta,
  browserStartScreencast,
  browserStopScreencast,
  browserViewportShot,
  SUBBROWSER_RUN_ID,
  type BrowserInputEvent,
} from '@/lib/browser';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'navigate') {
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return NextResponse.json({ ok: false, error: 'Enter a full http(s) URL, e.g. http://localhost:5173' }, { status: 400 });
      }
      await browserClearHighlight(SUBBROWSER_RUN_ID);
      await browserNavigate(url, SUBBROWSER_RUN_ID);
      // Keep live stream going if Interact mode is open; otherwise return a shot for Annotate.
      const live = !!body.live;
      if (live) {
        await browserEnsureScreencast(SUBBROWSER_RUN_ID);
        const meta = await browserPageMeta(SUBBROWSER_RUN_ID);
        const { audit } = await import('@/lib/audit-log');
        audit('workspace', 'sub-browser navigate', meta.url);
        return NextResponse.json({ ok: true, live: true, ...meta });
      }
      await browserStopScreencast();
      const shot = await browserFullShot(SUBBROWSER_RUN_ID);
      const { audit } = await import('@/lib/audit-log');
      audit('workspace', 'sub-browser navigate', shot.url);
      return NextResponse.json({ ok: true, live: false, ...shot });
    }

    if (action === 'start_live') {
      await browserClearHighlight(SUBBROWSER_RUN_ID);
      await browserStartScreencast(SUBBROWSER_RUN_ID);
      const meta = await browserPageMeta(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...meta });
    }

    if (action === 'stop_live') {
      await browserStopScreencast();
      return NextResponse.json({ ok: true });
    }

    // Live Interact: forward pointer/keyboard into the real page (viewport coords).
    if (action === 'input') {
      const kind = String(body.kind || '');
      const event = { kind, ...body } as BrowserInputEvent;
      if (!kind) {
        return NextResponse.json({ ok: false, error: 'input needs kind' }, { status: 400 });
      }
      await browserInput(event, SUBBROWSER_RUN_ID);
      // Lightweight meta so the URL bar can track client-side navigations.
      if (kind === 'click' || kind === 'mouseup' || kind === 'keydown') {
        const meta = await browserPageMeta(SUBBROWSER_RUN_ID).catch(() => null);
        return NextResponse.json({ ok: true, ...(meta || {}) });
      }
      return NextResponse.json({ ok: true });
    }

    // Annotate: freeze to a full-page screenshot and inspect by full-page coords.
    if (action === 'annotate_shot') {
      await browserStopScreencast();
      const shot = await browserFullShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'inspect') {
      // Support both full-page (annotate tall shot) and viewport coords.
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return NextResponse.json({ ok: false, error: 'inspect needs x/y coordinates' }, { status: 400 });
      }
      await browserStopScreencast();
      const fullPage = body.fullPage !== false;
      const element = fullPage
        ? await browserInspectAtFull(Math.round(x), Math.round(y), SUBBROWSER_RUN_ID)
        : await browserInspectAt(Math.round(x), Math.round(y), SUBBROWSER_RUN_ID);
      if (!element) return NextResponse.json({ ok: false, error: 'No element at that point' }, { status: 404 });
      await browserHighlight(element.selector, SUBBROWSER_RUN_ID);
      const shot = fullPage
        ? await browserFullShot(SUBBROWSER_RUN_ID)
        : await browserViewportShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, element, ...shot });
    }

    if (action === 'click') {
      // Legacy full-page click (annotate shot path) — prefer `input` for Interact.
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return NextResponse.json({ ok: false, error: 'click needs x/y coordinates' }, { status: 400 });
      }
      await browserClickAtFull(Math.round(x), Math.round(y), SUBBROWSER_RUN_ID);
      const shot = await browserFullShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'shot') {
      await browserStopScreencast();
      const shot = await browserFullShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'meta') {
      const meta = await browserPageMeta(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...meta });
    }

    return NextResponse.json({ ok: false, error: `Unknown sub-browser action "${action}"` }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'sub-browser action failed' }, { status: 500 });
  }
}
