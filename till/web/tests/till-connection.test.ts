import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, get, onAuthLost, post } from '../src/lib/api';
import { getTillConfig, saveTillConfig, testBranchServer } from '../src/lib/tillServer';

// docs/11-multi-branch.md §8.4: the till's own server answers for the branch server. What the screens must do with it.
afterEach(() => vi.restoreAllMocks());

const reply = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('when the till cannot reach its branch server', () => {
  it('is "offline" for the screens, so a sale goes to the queue and nobody is signed out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(
        502,
        { code: 'BRANCH_UNREACHABLE', detail: 'Cannot reach the branch server' },
        { 'content-type': 'application/problem+json', 'X-Till-Proxy-Error': 'BRANCH_UNREACHABLE' },
      ),
    );
    const lost = vi.fn();
    onAuthLost(lost);
    const err = (await post('/sales', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isNetwork).toBe(true);
    expect(err.code).toBe('BRANCH_UNREACHABLE');
    expect(lost).not.toHaveBeenCalled();
  });

  it('says when no address is saved yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(
        503,
        { code: 'BRANCH_NOT_CONFIGURED' },
        { 'content-type': 'application/problem+json', 'X-Till-Proxy-Error': 'BRANCH_NOT_CONFIGURED' },
      ),
    );
    const err = (await get('/products').catch((e: unknown) => e)) as ApiError;
    expect(err.isNetwork).toBe(true);
    expect(err.code).toBe('BRANCH_NOT_CONFIGURED');
  });

  it('keeps a real answer of the branch server as it is (a 503 from the branch server is not "offline")', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(503, { code: 'STARTING', detail: 'Starting' }, { 'content-type': 'application/problem+json' }),
    );
    const err = (await get('/products').catch((e: unknown) => e)) as ApiError;
    expect(err.isNetwork).toBe(false);
    expect(err.status).toBe(503);
  });
});

describe("the branch server address, kept by the till's own server", () => {
  it('is read from /till/config', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { branchServer: 'http://192.168.1.10:3000', source: 'saved' }));
    expect(await getTillConfig()).toEqual({ branchServer: 'http://192.168.1.10:3000', source: 'saved' });
    expect(String(spy.mock.calls[0]![0])).toBe('/till/config');
  });

  it('is null when the app is not served by a till (the branch server answers a page or a 404 instead)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(200, '<!doctype html>', { 'content-type': 'text/html' }));
    expect(await getTillConfig()).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(404, { code: 'NOT_FOUND' }));
    expect(await getTillConfig()).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('failed'));
    expect(await getTillConfig()).toBeNull();
  });

  it('saves an address, and a refusal comes back as the reason in words', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(200, { branchServer: 'http://shop-pc:3000', source: 'saved' }));
    expect((await saveTillConfig('shop-pc:3000')).branchServer).toBe('http://shop-pc:3000');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      reply(400, { code: 'VALIDATION', detail: 'Give only the server and port, with nothing after it' }),
    );
    await expect(saveTillConfig('http://a/b')).rejects.toThrow('Give only the server and port');
  });

  it('tests an address, and a till program that does not answer is a result, not a crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(200, { ok: true, ms: 12 }));
    expect(await testBranchServer('shop-pc:3000')).toEqual({ ok: true, ms: 12 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('failed'));
    expect(await testBranchServer()).toMatchObject({ ok: false, reason: 'TILL_DOWN' });
  });
});
