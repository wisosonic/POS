import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import type { EventBus } from './bus';

/** More open streams than this is a runaway client, not a shop (about 50 tills plus managers' screens). */
const MAX_STREAMS = 300;
const PING_SECONDS = 20;

/**
 * `GET /events`: a Server-Sent Events stream for a signed-in screen. Each event is `event: <type>` and a small JSON body
 * `{ type, at }`. A comment line every 20 seconds keeps the connection from being closed as idle, and tells a dead one apart.
 * The browser's EventSource cannot send our sign-in, so the web app reads this with `fetch` (apps/web/src/lib/events.ts).
 */
export default async function eventRoutes(app: FastifyInstance, opts: { bus: EventBus }) {
  const { bus } = opts;
  const open = new Set<(destroy?: boolean) => void>();

  // Closing the server must not wait for streams that never end on their own. This has to be `preClose`, not `onClose`: Fastify runs
  // `onClose` only AFTER the server has stopped waiting for its connections, which a stream never lets it finish. Ending the response
  // is not enough either (the connection would stay open as an idle keep-alive socket), so the connection itself is destroyed; the
  // screen notices, and reconnects when the server is back.
  app.addHook('preClose', async () => {
    for (const end of [...open]) end(true);
  });

  app.get('/events', { preHandler: app.authenticate }, async (req, reply) => {
    if (open.size >= MAX_STREAMS) throw new AppError(503, 'TOO_MANY_STREAMS', 'Too many screens are listening for updates');
    reply.hijack(); // from here the stream is ours: nothing else may write to this response
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.write('retry: 3000\n: connected\n\n');

    const stop = bus.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), PING_SECONDS * 1000);
    let ended = false;
    const end = (destroy = false) => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      stop();
      open.delete(end);
      if (destroy) res.destroy();
      else if (!res.writableEnded) res.end();
    };
    open.add(end);
    res.on('close', () => end()); // the screen went away
    res.on('error', () => end(true));
  });
}
