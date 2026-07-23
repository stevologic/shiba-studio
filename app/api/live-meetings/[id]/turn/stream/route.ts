import { streamLiveMeetingTurn } from '@/lib/live-meetings';
import { encodeLiveMeetingSseEvent } from '@/lib/live-meeting-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Streaming turns call the model and may capture a screenshot — allow slow replies. */
export const maxDuration = 300;

/**
 * Real-time meeting turn stream.
 *
 * Same SSE framing as multi-agent chat (`data: JSON\n\n`) so the room can
 * show progressive spoken text over `grokChatStream` before the durable turn
 * (visual + suggestions) settles.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: { text?: unknown; stageTurnId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const text = typeof body.text === 'string' ? body.text : null;
  const stageTurnId = typeof body.stageTurnId === 'string' ? body.stageTurnId : undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Parameters<typeof encodeLiveMeetingSseEvent>[0]) => {
        controller.enqueue(encoder.encode(encodeLiveMeetingSseEvent(event)));
      };
      try {
        for await (const event of streamLiveMeetingTurn(id, text, {
          stageTurnId,
          signal: request.signal,
        })) {
          send(event);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Meeting stream failed';
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
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