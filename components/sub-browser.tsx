'use client';

// Annotation sub-browser — load any page (typically the web app you are
// building on localhost), click an element DevTools-style to select it, add a
// note, and send the whole annotation (selector + HTML + highlighted
// screenshot) into Grok Chat for code refinement.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Crosshair, Globe, Loader2, MousePointer, RefreshCw, Send, X } from 'lucide-react';
import { toast } from 'sonner';

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
  const [shot, setShot] = useState<PageShot | null>(null);
  const [element, setElement] = useState<InspectedElement | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Interact = clicks pass through to the real page (follow links, press
  // buttons); Annotate = clicks select the element under the cursor.
  const [mode, setMode] = useState<'interact' | 'annotate'>('annotate');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const call = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch('/api/subbrowser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }, []);

  async function navigate() {
    let url = urlInput.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (!url) return;
    setBusy('Loading page…');
    setElement(null);
    try {
      const data = await call({ action: 'navigate', url });
      if (!data.ok) throw new Error(data.error || 'Navigation failed');
      setShot(data);
      setUrlInput(data.url);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Navigation failed');
    }
    setBusy(null);
  }

  async function scroll(direction: 'up' | 'down') {
    if (!shot) return;
    setBusy('Scrolling…');
    try {
      const data = await call({ action: 'scroll', direction });
      if (data.ok) setShot(data);
    } catch { /* keep view */ }
    setBusy(null);
  }

  async function refreshShot() {
    if (!shot) return;
    setBusy('Refreshing…');
    try {
      const data = await call({ action: 'shot' });
      if (data.ok) setShot(data);
    } catch { /* keep view */ }
    setBusy(null);
  }

  // Mouse wheel scrolls the live page (works in both modes). Bound as a native
  // non-passive listener — React registers wheel handlers passively, so a
  // synthetic onWheel can't preventDefault() and the modal scrolls instead of
  // the rendered page. Deltas accumulate and flush once the gesture settles,
  // so a scroll is one round-trip instead of dozens.
  const hasShot = !!shot;
  useEffect(() => {
    const img = imgRef.current;
    if (!open || !hasShot || !img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAccum.current += e.deltaY;
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(async () => {
        const dy = Math.round(wheelAccum.current);
        wheelAccum.current = 0;
        if (!dy) return;
        try {
          const data = await call({ action: 'scrollby', dy });
          if (data.ok) setShot(data);
        } catch { /* keep view */ }
      }, 140);
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      img.removeEventListener('wheel', onWheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    };
  }, [open, hasShot, call]);

  async function pick(e: React.MouseEvent<HTMLImageElement>) {
    if (!shot || !imgRef.current || busy) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    // Map the click from the rendered image to real page viewport coordinates.
    const x = ((e.clientX - rect.left) / rect.width) * shot.width;
    const y = ((e.clientY - rect.top) / rect.height) * shot.height;

    if (mode === 'interact') {
      // Forward the click to the live page (follow links, press buttons).
      setBusy('Clicking…');
      try {
        const data = await call({ action: 'click', x, y });
        if (!data.ok) throw new Error(data.error || 'Click failed');
        setShot(data);
        setUrlInput(data.url);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : 'Click failed');
      }
      setBusy(null);
      return;
    }

    setBusy('Inspecting element…');
    try {
      const data = await call({ action: 'inspect', x, y });
      if (!data.ok) throw new Error(data.error || 'Nothing selectable there');
      setElement(data.element);
      setShot(data);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Inspect failed');
    }
    setBusy(null);
  }

  function attach() {
    if (!shot || !element) return;
    const lines = [
      `I annotated an element on ${shot.url} using the sub-browser (it is outlined in orange in the attached screenshot).`,
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

    onAnnotate({ promptBlock: lines, screenshotDataUrl: shot.dataUrl, pageUrl: shot.url });
    setNote('');
    setElement(null);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="modal modal-pop w-full max-w-4xl p-5 max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-lg font-semibold flex items-center gap-2">
              <Crosshair size={17} className="opacity-70" /> Annotate a page
            </div>
            <div className="text-xs text-dim mt-0.5">
              Load the app you&apos;re building — use <strong>Interact</strong> to click around and navigate
              (scroll with your mouse wheel), then switch to <strong>Annotate</strong> to select an element
              (outlined orange) and send it to chat.
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <Globe size={14} className="text-dim shrink-0" />
          <input
            className="grok-input flex-1 min-w-0 font-mono text-xs"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void navigate(); }}
            placeholder="http://localhost:5173 — the app you're developing"
          />
          <button type="button" onClick={() => void navigate()} disabled={!!busy} className="grok-btn grok-btn-primary text-xs shrink-0">
            {busy === 'Loading page…' ? <Loader2 size={13} className="animate-spin" /> : 'Go'}
          </button>
          {shot && (
            <>
              <div className="subbrowser-mode shrink-0" role="group" aria-label="Pointer mode">
                <button
                  type="button"
                  onClick={() => setMode('interact')}
                  className={`subbrowser-mode-btn ${mode === 'interact' ? 'subbrowser-mode-active' : ''}`}
                  title="Interact — clicks pass through to the page: follow links, press buttons, navigate"
                >
                  <MousePointer size={12} /> Interact
                </button>
                <button
                  type="button"
                  onClick={() => setMode('annotate')}
                  className={`subbrowser-mode-btn ${mode === 'annotate' ? 'subbrowser-mode-active' : ''}`}
                  title="Annotate — clicks select the element under the cursor for refinement"
                >
                  <Crosshair size={12} /> Annotate
                </button>
              </div>
              <button type="button" onClick={() => void scroll('up')} disabled={!!busy} className="grok-btn grok-btn-ghost text-xs p-1.5 shrink-0" title="Scroll up">
                <ArrowUp size={13} />
              </button>
              <button type="button" onClick={() => void scroll('down')} disabled={!!busy} className="grok-btn grok-btn-ghost text-xs p-1.5 shrink-0" title="Scroll down">
                <ArrowDown size={13} />
              </button>
              <button type="button" onClick={() => void refreshShot()} disabled={!!busy} className="grok-btn grok-btn-ghost text-xs p-1.5 shrink-0" title="Refresh screenshot">
                <RefreshCw size={13} />
              </button>
            </>
          )}
        </div>

        <div className="subbrowser-stage flex-1 min-h-0 overflow-auto">
          {shot ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              ref={imgRef}
              src={shot.dataUrl}
              alt={shot.title || 'page'}
              className={`subbrowser-shot ${mode === 'interact' ? 'subbrowser-shot-interact' : ''}`}
              onClick={(e) => void pick(e)}
            />
          ) : (
            <div className="text-sm text-dim text-center py-16">
              Enter a URL above — usually the dev server of the app you&apos;re building — and press Go.
            </div>
          )}
        </div>

        {busy && <div className="data-loading-row text-xs mt-2"><span className="data-spinner" /> {busy}</div>}

        {element && (
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
