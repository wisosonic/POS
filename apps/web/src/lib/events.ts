// Live updates from the server (`GET /events`, docs/06-api-spec.md). The browser's EventSource cannot send our sign-in or the till's
// token, so the stream is read with fetch. An event is only a HINT ("the catalog changed"): the screen asks for the real thing through
// the normal, authorised calls. If the stream drops, nothing is lost that a refresh does not bring back, so on every reconnect the
// caller refreshes everything (`onConnected(true)`).

export const LIVE_EVENTS = [
  'catalog.changed',
  'stock.changed',
  'rate.changed',
  'settings.changed',
  'register.updated',
  'sale.completed',
  'sync.changed',
] as const;
export type LiveEvent = (typeof LIVE_EVENTS)[number];

type Frame = { event: string; data: string };

/**
 * Cut as many whole events as there are out of what has arrived so far. A chunk can end in the middle of an event, so what is left
 * over (`rest`) is kept and put in front of the next chunk. Comment lines (": ping") and the `retry:` hint are ignored.
 */
export function parseSse(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  const text = buffer.replace(/\r\n/g, '\n');
  const parts = text.split('\n\n');
  const rest = parts.pop() ?? ''; // the last part is whatever has not been finished yet
  for (const part of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

export type StreamOptions = {
  /** Open the stream (with the sign-in). */
  open: (signal: AbortSignal) => Promise<Response>;
  onEvent: (type: LiveEvent) => void;
  /** The stream is open. `again` is false the first time and true after a reconnect (so the screen should refresh everything). */
  onConnected?: (again: boolean) => void;
  /** Wait before reconnecting: starts at the first, doubles up to the second. */
  backoffMs?: [number, number];
};

const known = new Set<string>(LIVE_EVENTS);

/** Keep a stream open, reconnecting with growing waits. Returns the function that stops it. */
export function startEvents(opts: StreamOptions): () => void {
  const stop = new AbortController();
  const [minDelay, maxDelay] = opts.backoffMs ?? [1_000, 30_000];

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', done);
        resolve();
      }
      stop.signal.addEventListener('abort', done);
    });

  void (async () => {
    let delay = minDelay;
    let connectedBefore = false;
    while (!stop.signal.aborted) {
      try {
        const res = await opts.open(stop.signal);
        // Signed out, or not allowed: reconnecting would only repeat it. (A new sign-in remounts the screen and starts again.)
        if (res.status === 401 || res.status === 403) return;
        if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}`);
        opts.onConnected?.(connectedBefore);
        connectedBefore = true;
        delay = minDelay;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSse(pending + decoder.decode(value, { stream: true }));
          pending = parsed.rest;
          for (const frame of parsed.frames) if (known.has(frame.event)) opts.onEvent(frame.event as LiveEvent);
        }
        await sleep(minDelay); // the server closed the stream (a restart): come back shortly
      } catch {
        if (stop.signal.aborted) return;
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  })();

  return () => stop.abort();
}
