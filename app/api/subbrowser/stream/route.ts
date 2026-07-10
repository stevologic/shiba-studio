import { NextRequest } from 'next/server';
import {
  browserEnsureScreencast,
  browserLastScreencastFrame,
  browserSubscribeScreencast,
  type ScreencastFrame,
} from '@/lib/browser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Live viewport screencast for the sub-browser Interact mode.
 *  SSE of JPEG frames from headless Chrome (CDP Page.startScreencast). */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await browserEnsureScreencast();
      } catch (e: unknown) {
        send({ type: 'error', message: e instanceof Error ? e.message : 'Failed to start live view' });
        controller.close();
        return;
      }

      const pushFrame = (frame: ScreencastFrame) => {
        send({
          type: 'frame',
          dataUrl: frame.dataUrl,
          width: frame.width,
          height: frame.height,
          url: frame.url,
          title: frame.title,
          ts: frame.ts,
        });
      };

      const last = browserLastScreencastFrame();
      if (last) pushFrame(last);

      unsub = browserSubscribeScreencast(pushFrame);
      send({ type: 'ready' });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      const onAbort = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
        unsub = null;
        try { controller.close(); } catch { /* */ }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
      unsub = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
