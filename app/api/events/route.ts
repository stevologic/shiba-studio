import { NextRequest } from 'next/server';
import { subscribeAppEvents } from '@/lib/app-events';

export const dynamic = 'force-dynamic';

/**
 * Live change feed (SSE). The browser holds one EventSource per tab; stores
 * emit on every data change (runs, board, chats, agents, config) and the UI
 * refreshes the affected slice — no page refresh, no tight polling.
 */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      write(`retry: 3000\n\n`);
      unsubscribe = subscribeAppEvents((evt) => {
        write(`data: ${JSON.stringify(evt)}\n\n`);
      });
      // Keep intermediaries from timing the idle stream out; enqueue on a
      // closed controller throws, which tears this subscriber down below.
      heartbeat = setInterval(() => {
        try {
          write(`: ping\n\n`);
        } catch {
          cleanup();
        }
      }, 25_000);
      const cleanup = () => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        unsubscribe?.();
        unsubscribe = null;
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
