'use client';

// Annotation sub-browser — load any page (typically the web app you are
// building on localhost). Interact mode is a live remote Chrome session
// (CDP screencast + real input). Annotate mode freezes a full-page
// screenshot so you can pick an element DevTools-style and send it to chat.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Globe, Loader2, MousePointer, RefreshCw, Send, X } from 'lucide-react';
import { toast } from '@/lib/toast';

interface InspectedElement {
  selector: string;
  tag: string;
  id?: string;
  className?: string;
  rect: { x: number; y: number; width: number; height: number };
  outerHTML: string;
  text: string;
}

export interface SubBrowserAnnotation {
  promptBlock: string;
  screenshotDataUrl: string;
  pageUrl: string;
}

interface SubBrowserProps {
  open: boolean;
  onClose: () => void;
  onAnnotate: (annotation: SubBrowserAnnotation) => void;
  initialUrl?: string;
}

interface PageShot {
  dataUrl: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

export default function SubBrowser({ open, onClose, onAnnotate, initialUrl }: SubBrowserProps) {
  const [urlInput, setUrlInput] = useState(initialUrl || 'http://localhost:');
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [hasPage, setHasPage] = useState(false);
  // Live frame (Interact) vs frozen full-page shot (Annotate)
  const [liveFrame, setLiveFrame] = useState<PageShot | null>(null);
  const [annotateShot, setAnnotateShot] = useState<PageShot | null>(null);
  const [element, setElement] = useState<InspectedElement | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Default Interact — feels like a real browser; Annotate freezes to a shot.
  const [mode, setMode] = useState<'interact' | 'annotate'>('interact');
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveEpoch, setLiveEpoch] = useState(0);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const viewportRef = useRef({ width: 1280, height: 800 });
  // Throttle mousemove so we don't flood the API.
  const lastMoveSent = useRef(0);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());

  const call = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch('/api/subbrowser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }, []);

  const sendInput = useCallback((payload: Record<string, unknown>) => {
    // Serialize inputs so click order is preserved under load.
    inputQueue.current = inputQueue.current
      .then(async () => {
        const data = await call({ action: 'input', ...payload });
        if (data?.url) {
          setPageUrl(data.url);
          setUrlInput(data.url);
        }
        if (data?.title) setPageTitle(data.title);
      })
      .catch(() => { /* drop dropped input */ });
  }, [call]);

  const stopLiveStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setLiveConnected(false);
  }, []);

  const startLiveStream = useCallback(() => {
    const es = new EventSource('/api/subbrowser/stream');
    esRef.current = es;
    es.onmessage = (ev) => {
      if (esRef.current !== es) return;
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'frame' && data.dataUrl) {
          const frame: PageShot = {
            dataUrl: data.dataUrl,
            width: data.width || 1280,
            height: data.height || 800,
            url: data.url || '',
            title: data.title || '',
          };
          viewportRef.current = { width: frame.width, height: frame.height };
          setLiveFrame(frame);
          setHasPage(true);
          if (frame.url) {
            setPageUrl(frame.url);
            // Don't fight the user while they're typing a new URL.
            setUrlInput((prev) => (document.activeElement?.id === 'subbrowser-url' ? prev : frame.url || prev));
          }
          if (frame.title) setPageTitle(frame.title);
        } else if (data.type === 'ready') {
          setLiveConnected(true);
        } else if (data.type === 'error') {
          toast.error(data.message || 'Live view failed');
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => {
      if (esRef.current !== es) return;
      setLiveConnected(false);
      // EventSource auto-reconnects; no toast spam.
    };
  }, []);

  // Open/close lifecycle — attach to the shared agent page if one is already open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await call({ action: 'meta' });
        if (cancelled) return;
        if (meta?.ok && meta.url && meta.url !== 'about:blank') {
          setHasPage(true);
          setPageUrl(meta.url);
          setUrlInput(meta.url);
          setPageTitle(meta.title || '');
          viewportRef.current = { width: meta.width || 1280, height: meta.height || 800 };
        }
      } catch { /* fresh session */ }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, call]);

  // This effect is the sole owner of the live EventSource. The stream route
  // starts the CDP screencast and stops it when the last subscriber leaves.
  useEffect(() => {
    if (!open || mode !== 'interact' || !hasPage) return;
    const start = window.setTimeout(startLiveStream, 0);
    return () => {
      window.clearTimeout(start);
      stopLiveStream();
    };
  }, [open, mode, hasPage, liveEpoch, startLiveStream, stopLiveStream]);

  async function navigate() {
    let url = urlInput.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (!url) return;
    setBusy('Loading page…');
    setElement(null);
    setAnnotateShot(null);
    try {
      const live = mode === 'interact';
      const data = await call({ action: 'navigate', url, live });
      if (!data.ok) throw new Error(data.error || 'Navigation failed');
      setHasPage(true);
      setPageUrl(data.url || url);
      setUrlInput(data.url || url);
      setPageTitle(data.title || '');
      if (live) {
        viewportRef.current = { width: data.width || 1280, height: data.height || 800 };
      } else if (data.dataUrl) {
        setAnnotateShot(data as PageShot);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Navigation failed');
    }
    setBusy(null);
  }

  async function switchMode(next: 'interact' | 'annotate') {
    if (next === mode) return;
    setMode(next);
    setElement(null);
    if (!hasPage) return;

    if (next === 'annotate') {
      // Freeze: stop live stream, capture full-page screenshot for picking.
      setBusy('Capturing page for annotation…');
      try {
        const data = await call({ action: 'annotate_shot' });
        if (!data.ok) throw new Error(data.error || 'Capture failed');
        setAnnotateShot(data as PageShot);
        setPageUrl(data.url || pageUrl);
        setUrlInput(data.url || urlInput);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Could not capture page');
      }
      setBusy(null);
      return;
    }

    // Back to Interact — live remote browser again.
    setAnnotateShot(null);
  }

  async function refreshView() {
    if (!hasPage) return;
    if (mode === 'interact') {
      setLiveEpoch((epoch) => epoch + 1);
      return;
    }
    setBusy('Refreshing…');
    try {
      const data = await call({ action: 'annotate_shot' });
      if (data.ok) setAnnotateShot(data as PageShot);
    } catch { /* keep view */ }
    setBusy(null);
  }

  /** Map a pointer event on the live viewport → page coords.
   *  Accounts for object-fit:contain + object-position:top center letterboxing. */
  function liveCoords(e: React.MouseEvent | React.WheelEvent): { x: number; y: number } | null {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const vw = viewportRef.current.width || liveFrame?.width || 1280;
    const vh = viewportRef.current.height || liveFrame?.height || 800;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale;
    const offsetX = (rect.width - dispW) / 2;
    const offsetY = 0; // top-aligned
    const x = (e.clientX - rect.left - offsetX) / scale;
    const y = (e.clientY - rect.top - offsetY) / scale;
    if (x < 0 || y < 0 || x >= vw || y >= vh) return null;
    return {
      x: Math.max(0, Math.min(vw - 1, Math.round(x))),
      y: Math.max(0, Math.min(vh - 1, Math.round(y))),
    };
  }

  function onLiveMouseDown(e: React.MouseEvent) {
    if (mode !== 'interact' || busy) return;
    e.preventDefault();
    liveRef.current?.focus();
    const c = liveCoords(e);
    if (!c) return;
    sendInput({ kind: 'mousedown', x: c.x, y: c.y, button: e.button });
  }

  function onLiveMouseUp(e: React.MouseEvent) {
    if (mode !== 'interact' || busy) return;
    e.preventDefault();
    const c = liveCoords(e);
    if (!c) return;
    // down+up is enough for the page to emit click; avoid a second synthetic click.
    sendInput({ kind: 'mouseup', x: c.x, y: c.y, button: e.button });
  }

  function onLiveMouseMove(e: React.MouseEvent) {
    if (mode !== 'interact' || busy) return;
    const now = performance.now();
    if (now - lastMoveSent.current < 32) return; // ~30 Hz
    lastMoveSent.current = now;
    const c = liveCoords(e);
    if (!c) return;
    sendInput({ kind: 'mousemove', x: c.x, y: c.y });
  }

  function onLiveWheel(e: React.WheelEvent) {
    if (mode !== 'interact' || busy) return;
    e.preventDefault();
    const c = liveCoords(e);
    if (!c) return;
    sendInput({ kind: 'wheel', x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
  }

  function onLiveDoubleClick(e: React.MouseEvent) {
    if (mode !== 'interact' || busy) return;
    e.preventDefault();
    const c = liveCoords(e);
    if (!c) return;
    sendInput({ kind: 'dblclick', x: c.x, y: c.y });
  }

  function onLiveKeyDown(e: React.KeyboardEvent) {
    if (mode !== 'interact') return;
    // Don't steal browser chrome shortcuts while typing in the URL bar.
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    sendInput({
      kind: 'keydown',
      key: e.key,
      code: e.code,
      text: e.key.length === 1 ? e.key : undefined,
    });
  }

  function onLiveKeyUp(e: React.KeyboardEvent) {
    if (mode !== 'interact') return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    e.preventDefault();
    sendInput({ kind: 'keyup', key: e.key, code: e.code });
  }

  /** Annotate: pick element on the frozen full-page screenshot. */
  async function pickAnnotate(e: React.MouseEvent<HTMLImageElement>) {
    if (!annotateShot || !imgRef.current || busy || mode !== 'annotate') return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * annotateShot.width;
    const y = ((e.clientY - rect.top) / rect.height) * annotateShot.height;

    setBusy('Inspecting element…');
    try {
      const data = await call({ action: 'inspect', x, y, fullPage: true });
      if (!data.ok) throw new Error(data.error || 'Nothing selectable there');
      setElement(data.element);
      setAnnotateShot({
        dataUrl: data.dataUrl,
        width: data.width,
        height: data.height,
        url: data.url,
        title: data.title,
      });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Inspect failed');
    }
    setBusy(null);
  }

  function attach() {
    if (!annotateShot || !element) return;
    const lines = [
      `I annotated an element on ${annotateShot.url} using the sub-browser (it is outlined in orange in the attached screenshot).`,
      '',
      `**Selected element:** \`${element.selector}\` (<${element.tag}>${element.id ? ` id="${element.id}"` : ''})`,
      element.rect ? `**Size:** ${element.rect.width}×${element.rect.height}px` : '',
      note.trim() ? `**What I want:** ${note.trim()}` : '',
      '',
      '```html',
      element.outerHTML.slice(0, 2500),
      '```',
      '',
      'Please refine the code for this element accordingly.',
    ].filter((l) => l !== undefined && l !== null).join('\n');

    onAnnotate({ promptBlock: lines, screenshotDataUrl: annotateShot.dataUrl, pageUrl: annotateShot.url });
    setNote('');
    setElement(null);
    onClose();
  }

  if (!open) return null;

  const showLive = mode === 'interact' && hasPage;
  const showShot = mode === 'annotate' && annotateShot;

  return (
    // z-100: the annotation surface must sit above every chat window
    // (chat lightbox 80, voice HUD 80, terminal panel 72).
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4" onClick={onClose}>
      <div className="modal modal-pop w-full max-w-5xl p-5 max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-lg font-semibold flex items-center gap-2">
              <Crosshair size={17} className="opacity-70" /> Annotate a page
            </div>
            <div className="text-xs text-dim mt-0.5">
              <strong>Interact</strong> is a live remote browser — click, scroll, and type like normal.
              Switch to <strong>Annotate</strong> to freeze a screenshot, select an element (orange outline), and send it to chat.
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <Globe size={14} className="text-dim shrink-0" />
          <input
            id="subbrowser-url"
            className="grok-input flex-1 min-w-0 font-mono text-xs"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void navigate(); }}
            placeholder="http://localhost:5173 — the app you're developing"
          />
          <button type="button" onClick={() => void navigate()} disabled={!!busy} className="grok-btn grok-btn-primary text-xs shrink-0">
            {busy === 'Loading page…' ? <Loader2 size={13} className="animate-spin" /> : 'Go'}
          </button>
          {hasPage && (
            <>
              <div className="subbrowser-mode shrink-0" role="group" aria-label="Pointer mode">
                <button
                  type="button"
                  onClick={() => void switchMode('interact')}
                  className={`subbrowser-mode-btn ${mode === 'interact' ? 'subbrowser-mode-active' : ''}`}
                  title="Interact — live remote browser: click, scroll, type"
                >
                  <MousePointer size={12} /> Interact
                  {mode === 'interact' && liveConnected && <span className="subbrowser-live-dot" title="Live" />}
                </button>
                <button
                  type="button"
                  onClick={() => void switchMode('annotate')}
                  className={`subbrowser-mode-btn ${mode === 'annotate' ? 'subbrowser-mode-active' : ''}`}
                  title="Annotate — freeze screenshot and select an element"
                >
                  <Crosshair size={12} /> Annotate
                </button>
              </div>
              <button type="button" onClick={() => void refreshView()} disabled={!!busy} className="grok-btn grok-btn-ghost text-xs p-1.5 shrink-0" title={mode === 'interact' ? 'Reconnect live view' : 'Refresh screenshot'}>
                <RefreshCw size={13} />
              </button>
            </>
          )}
        </div>

        {pageTitle && hasPage && (
          <div className="text-[11px] text-dim mb-2 truncate" title={pageUrl}>
            {pageTitle}{pageUrl ? ` — ${pageUrl}` : ''}
            {mode === 'interact' && (
              <span className="ml-2 opacity-70">{liveConnected ? '● live' : '○ connecting…'}</span>
            )}
            {mode === 'annotate' && <span className="ml-2 opacity-70">screenshot · click to select</span>}
          </div>
        )}

        <div className={`subbrowser-stage flex-1 min-h-0 ${mode === 'interact' ? 'subbrowser-stage-live' : 'overflow-auto'}`}>
          {showLive && liveFrame ? (
            <div
              ref={liveRef}
              className="subbrowser-live"
              tabIndex={0}
              role="application"
              aria-label="Live browser view"
              onMouseDown={onLiveMouseDown}
              onMouseUp={onLiveMouseUp}
              onMouseMove={onLiveMouseMove}
              onDoubleClick={onLiveDoubleClick}
              onWheel={onLiveWheel}
              onKeyDown={onLiveKeyDown}
              onKeyUp={onLiveKeyUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={liveFrame.dataUrl}
                alt={pageTitle || 'live page'}
                className="subbrowser-live-frame"
                draggable={false}
              />
            </div>
          ) : showShot ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              ref={imgRef}
              src={annotateShot!.dataUrl}
              alt={annotateShot!.title || 'page'}
              className="subbrowser-shot"
              onClick={(e) => void pickAnnotate(e)}
            />
          ) : (
            <div className="text-sm text-dim text-center py-16">
              Enter a URL above — usually the dev server of the app you&apos;re building — and press Go.
              {mode === 'interact' && hasPage && !liveFrame && (
                <div className="mt-2 text-xs">Connecting live view…</div>
              )}
            </div>
          )}
        </div>

        {busy && <div className="data-loading-row text-xs mt-2"><span className="data-spinner" /> {busy}</div>}

        {mode === 'annotate' && element && (
          <div className="subbrowser-selection mt-3">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="tool-chip tool-chip-local shrink-0">selected</span>
              <span className="font-mono truncate min-w-0" title={element.selector}>{element.selector}</span>
              <span className="text-dim shrink-0">{element.rect.width}×{element.rect.height}px</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input
                className="grok-input flex-1 min-w-0 text-xs"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') attach(); }}
                placeholder="What should change about this element? e.g. make this container responsive with a 2-column grid"
              />
              <button type="button" onClick={attach} className="grok-btn grok-btn-primary text-xs shrink-0">
                <Send size={13} /> Send to chat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
