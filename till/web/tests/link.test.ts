import { afterEach, describe, expect, it, vi } from 'vitest';
import { sellingBlock } from '../src/lib/link';
import { getTillLink, type TillLink } from '../src/lib/tillServer';

// docs/14: selling stops while the branch server does not answer. The screen asks the till's own server (GET /till/link).
const link = (over: Partial<TillLink> = {}): TillLink => ({
  state: 'connected',
  blocked: false,
  since: '2026-11-27T09:00:00.000Z',
  lastOkAt: '2026-11-27T09:00:00.000Z',
  reason: null,
  detail: null,
  ...over,
});

describe('when selling stops (US-10)', () => {
  it('stays allowed while the branch server answers, and while the link is not known yet', () => {
    expect(sellingBlock(link())).toBeNull();
    expect(sellingBlock(link({ state: 'starting' }))).toBeNull();
  });
  it('stays allowed when this app has no till server to ask (served by the branch server itself)', () => {
    expect(sellingBlock(null)).toBeNull();
  });
  it('stays allowed for a device the server does not know: the screens offer to enrol it, the link is fine', () => {
    expect(sellingBlock(link({ state: 'not_a_till' }))).toBeNull();
  });
  it('stops when the branch server is down, and carries the reason', () => {
    expect(sellingBlock(link({ state: 'down', blocked: true, reason: 'TIMEOUT', detail: 'x' }))).toEqual({
      cause: 'branch',
      reason: 'TIMEOUT',
      detail: 'x',
    });
  });
  it('stops when the till program on this PC does not answer', () => {
    expect(sellingBlock('till-down')).toMatchObject({ cause: 'till' });
  });
});

describe('asking the till for the link', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (init: { ok?: boolean; type?: string; body?: unknown }) =>
    vi.fn(async () => ({
      ok: init.ok ?? true,
      headers: { get: () => init.type ?? 'application/json' },
      json: async () => init.body,
    }));

  it('sends the device token to the till (so the heartbeat can use the guarded ping), and never to anywhere else', async () => {
    const fetchMock = answer({ body: link() });
    vi.stubGlobal('fetch', fetchMock);
    expect(await getTillLink('device-token')).toEqual(link());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('/till/link');
    expect(init.headers['X-Terminal-Token']).toBe('device-token');
  });

  it('sends no token header when this browser has none', async () => {
    const fetchMock = answer({ body: link() });
    vi.stubGlobal('fetch', fetchMock);
    await getTillLink(null);
    const init = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers).not.toHaveProperty('X-Terminal-Token');
  });

  it('says the till program is down when it cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await getTillLink(null)).toBe('till-down');
  });

  it('says there is no till server when the address answers with something else (a web page, a 404)', async () => {
    vi.stubGlobal('fetch', answer({ type: 'text/html', body: '<html>' }));
    expect(await getTillLink(null)).toBeNull();
    vi.stubGlobal('fetch', answer({ ok: false, body: {} }));
    expect(await getTillLink(null)).toBeNull();
    vi.stubGlobal('fetch', answer({ body: { nothing: 'useful' } }));
    expect(await getTillLink(null)).toBeNull();
  });
});
