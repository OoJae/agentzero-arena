/**
 * app/api/stream/route.ts — Server-Sent Events endpoint.
 *
 * Tails the arena SQLite DB and pushes ArenaState to the dashboard ~1×/s. The worker
 * is the sole writer (WAL mode); this route only reads. Two-process decoupling: the
 * long-lived worker and the Next app share one DB file as the bus.
 */
import { readArenaState } from "@/lib/arena";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUSH_INTERVAL_MS = 1000;

export async function GET() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          const state = readArenaState();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
        } catch (err) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`),
          );
        }
      };
      send(); // initial snapshot
      timer = setInterval(send, PUSH_INTERVAL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
