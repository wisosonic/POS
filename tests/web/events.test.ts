import { describe, it, expect } from 'vitest';
import { parseSse, startEvents, type LiveEvent } from '../../apps/web/src/lib/events';

// Live updates (docs/06 `GET /events`): reading the stream, and keeping it open.
const frame = (type: string) => `event: ${type}\ndata: ${JSON.stringify({ type, at: '2026-11-23T10:00:00.000Z' })}\n\n`;

describe('reading the stream', () => {
  it('cuts whole events out of what has arrived, in order', () => {
    const { frames, rest } = parseSse(frame('stock.changed') + frame('rate.changed'));
    expect(frames.map((f) => f.event)).toEqual(['stock.changed', 'rate.changed']);
    expect(JSON.parse(frames[0]!.data)).toEqual({ type: 'stock.changed', at: '2026-11-23T10:00:00.000Z' });
    expect(rest).toBe('');
  });

  it('keeps an unfinished event for the next chunk, wherever the chunk ends', () => {
    const whole = frame('catalog.changed') + frame('stock.changed');
    for (let cut = 1; cut < whole.length; cut++) {
      const first = parseSse(whole.slice(0, cut));
      const second = parseSse(first.rest + whole.slice(cut));
      expect(
        [...first.frames, ...second.frames].map((f) => f.event),
        `cut at ${cut}`,
      ).toEqual(['catalog.changed', 'stock.changed']);
    }
  });

  it('ignores the comment lines (the ping and the connected note) and the retry hint', () => {
    const { frames, rest } = parseSse(`retry: 3000\n: connected\n\n: ping\n\n${frame('register.updated')}`);
    expect(frames.map((f) => f.event)).toEqual(['register.updated']);
    expect(rest).toBe('');
  });

  it('copes with Windows line endings and several data lines', () => {
    const { frames } = parseSse('event: settings.changed\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(frames).toEqual([{ event: 'settings.changed', data: 'a\nb' }]);
  });

  it('an event with no data is not an event', () => {
    expect(parseSse('event: stock.changed\n\n').frames).toEqual([]);
  });
});

/** A stream that delivers the given chunks, then ends (or stays open if `hold`). */
const streamOf = (chunks: string[], { hold = false, status = 200 }: { hold?: boolean; status?: number } = {}) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (!hold) controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
};
const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 5));
  return check();
};

describe('keeping the stream open', () => {
  it('hands each known event to the screen, and ignores one it does not know', async () => {
    const heard: LiveEvent[] = [];
    const stop = startEvents({
      open: async () => streamOf([frame('catalog.changed'), frame('something.new'), frame('stock.changed')], { hold: true }),
      onEvent: (t) => heard.push(t),
    });
    expect(await until(() => heard.length === 2)).toBe(true);
    stop();
    expect(heard).toEqual(['catalog.changed', 'stock.changed']);
  });

  it('puts an event back together when it arrives in pieces', async () => {
    const heard: LiveEvent[] = [];
    const whole = frame('rate.changed');
    const stop = startEvents({
      open: async () => streamOf([whole.slice(0, 7), whole.slice(7, 20), whole.slice(20)], { hold: true }),
      onEvent: (t) => heard.push(t),
    });
    expect(await until(() => heard.length === 1)).toBe(true);
    stop();
    expect(heard).toEqual(['rate.changed']);
  });

  it('says it is the first connection, then that it is a reconnection (so the screen refreshes what it may have missed)', async () => {
    const connected: boolean[] = [];
    const stop = startEvents({
      open: async () => streamOf([frame('stock.changed')]), // each stream ends: the server restarted
      onEvent: () => undefined,
      onConnected: (again) => connected.push(again),
      backoffMs: [5, 20],
    });
    expect(await until(() => connected.length >= 3)).toBe(true);
    stop();
    expect(connected.slice(0, 3)).toEqual([false, true, true]);
  });

  it('keeps trying, waiting longer each time, while the server cannot be reached, and recovers', async () => {
    const times: number[] = [];
    const connected: boolean[] = [];
    let opens = 0;
    const stop = startEvents({
      open: async () => {
        times.push(Date.now());
        if (++opens <= 3) throw new TypeError('fetch failed');
        return streamOf([], { hold: true });
      },
      onEvent: () => undefined,
      onConnected: (again) => connected.push(again),
      backoffMs: [20, 200],
    });
    expect(await until(() => connected.length === 1)).toBe(true);
    stop();
    expect(opens).toBe(4);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps[1]!).toBeGreaterThanOrEqual(gaps[0]! - 5); // growing (allowing for timer jitter)
    expect(gaps[2]!).toBeGreaterThanOrEqual(gaps[1]! - 5);
    expect(connected).toEqual([false]); // never connected before, so not a "reconnection"
  });

  it('does not reconnect when the server says the person is not signed in or not allowed', async () => {
    for (const status of [401, 403]) {
      let opens = 0;
      const stop = startEvents({ open: async () => (++opens, streamOf([], { status })), onEvent: () => undefined, backoffMs: [5, 10] });
      await new Promise((r) => setTimeout(r, 80));
      stop();
      expect(opens, `status ${status}`).toBe(1);
    }
  });

  it('keeps trying after a server error (5xx): it may only be restarting', async () => {
    let opens = 0;
    const stop = startEvents({ open: async () => (++opens, streamOf([], { status: 503 })), onEvent: () => undefined, backoffMs: [5, 10] });
    expect(await until(() => opens >= 3)).toBe(true);
    stop();
  });

  it('stops when asked, even in the middle of waiting for the next event', async () => {
    let aborted = false;
    const stop = startEvents({
      open: async (signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return streamOf([], { hold: true });
      },
      onEvent: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(await until(() => aborted)).toBe(true);
  });
});
