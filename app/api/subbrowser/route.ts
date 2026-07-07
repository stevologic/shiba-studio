import { NextRequest, NextResponse } from 'next/server';
import {
  browserClickAt,
  browserHighlight,
  browserInspectAt,
  browserNavigate,
  browserScroll,
  browserViewportShot,
} from '@/lib/browser';

// The annotation sub-browser shares one persistent puppeteer page, separate
// from agent-run pages, so navigation state survives between actions.
const SUBBROWSER_RUN_ID = '__subbrowser__';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'navigate') {
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return NextResponse.json({ ok: false, error: 'Enter a full http(s) URL, e.g. http://localhost:5173' }, { status: 400 });
      }
      await browserNavigate(url, SUBBROWSER_RUN_ID);
      const shot = await browserViewportShot(SUBBROWSER_RUN_ID);
      const { audit } = await import('@/lib/audit-log');
      audit('workspace', 'sub-browser navigate', shot.url);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'inspect') {
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return NextResponse.json({ ok: false, error: 'inspect needs x/y coordinates' }, { status: 400 });
      }
      const element = await browserInspectAt(Math.round(x), Math.round(y), SUBBROWSER_RUN_ID);
      if (!element) return NextResponse.json({ ok: false, error: 'No element at that point' }, { status: 404 });
      await browserHighlight(element.selector, SUBBROWSER_RUN_ID);
      const shot = await browserViewportShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, element, ...shot });
    }

    if (action === 'click') {
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return NextResponse.json({ ok: false, error: 'click needs x/y coordinates' }, { status: 400 });
      }
      await browserClickAt(Math.round(x), Math.round(y), SUBBROWSER_RUN_ID);
      const shot = await browserViewportShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'scroll') {
      const dir = ['up', 'down', 'top', 'bottom'].includes(body.direction) ? body.direction : 'down';
      await browserScroll(dir, SUBBROWSER_RUN_ID);
      const shot = await browserViewportShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    if (action === 'shot') {
      const shot = await browserViewportShot(SUBBROWSER_RUN_ID);
      return NextResponse.json({ ok: true, ...shot });
    }

    return NextResponse.json({ ok: false, error: `Unknown sub-browser action "${action}"` }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'sub-browser action failed' }, { status: 500 });
  }
}
