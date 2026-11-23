import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, get, onAuthLost, post } from '../../apps/web/src/lib/api';
import { clearTerminalToken, getTerminalToken, setTerminalToken, subscribeTerminal } from '../../apps/web/src/lib/terminal';

// US-26 / docs/11-multi-branch.md §3.4: the till's device token is kept in this browser and goes with every request.
const memoryStore = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
};
const blocked = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

afterEach(() => {
  clearTerminalToken(null);
  vi.restoreAllMocks();
});

describe('the till token in this browser', () => {
  it('is kept in storage and read back', () => {
    const store = memoryStore();
    expect(getTerminalToken(store)).toBeNull();
    setTerminalToken('device-token', store);
    expect(store.data.get('pos.terminalToken')).toBe('device-token');
    expect(getTerminalToken(store)).toBe('device-token');
    clearTerminalToken(store);
    expect(store.data.size).toBe(0);
  });

  it('still works for this page when storage is blocked (it is kept in memory)', () => {
    expect(() => setTerminalToken('in-memory', blocked)).not.toThrow();
    expect(getTerminalToken(blocked)).toBe('in-memory');
    expect(() => clearTerminalToken(blocked)).not.toThrow();
    expect(getTerminalToken(blocked)).toBeNull();
  });

  it('tells the screens when it changes', () => {
    const seen: (string | null)[] = [];
    const stop = subscribeTerminal(() => seen.push(getTerminalToken(null)));
    setTerminalToken('a', null);
    clearTerminalToken(null);
    stop();
    setTerminalToken('b', null); // nobody is listening any more
    expect(seen).toEqual(['a', null]);
  });
});

describe('the till token on requests', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let calls: { url: string; headers: Record<string, string> }[];
  const fetching = (...answers: Response[]) => {
    calls = [];
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      return answers.shift() ?? json(200, {});
    });
  };

  beforeEach(() => {
    calls = [];
  });

  it('sends X-Terminal-Token with every request once the till is enrolled, and not before', async () => {
    fetching(json(200, {}), json(200, {}));
    await get('/stock');
    setTerminalToken('device-token', null);
    await post('/sales', { items: [] }, { idempotencyKey: 'k1' });
    expect(calls[0]!.headers['X-Terminal-Token']).toBeUndefined();
    expect(calls[1]!.headers['X-Terminal-Token']).toBe('device-token');
    expect(calls[1]!.headers['Idempotency-Key']).toBe('k1'); // a queued sale sent later carries both
  });

  it('a till the server no longer knows is forgotten, and the person is NOT signed out', async () => {
    setTerminalToken('revoked-token', null);
    const lost = vi.fn();
    onAuthLost(lost);
    fetching(json(401, { code: 'TERMINAL_UNKNOWN', detail: 'This device is not a registered till' }));

    await expect(get('/registers/current')).rejects.toMatchObject({ status: 401, code: 'TERMINAL_UNKNOWN' });
    expect(getTerminalToken(null)).toBeNull(); // the screen then offers to set the till up again
    expect(lost).not.toHaveBeenCalled(); // not a lost sign-in
    expect(calls).toHaveLength(1); // and no refresh was attempted
    onAuthLost(() => undefined);
  });

  it('an ordinary 401 still tries to refresh the sign-in, and keeps the till token', async () => {
    setTerminalToken('good-token', null);
    fetching(json(401, { code: 'UNAUTHENTICATED' }), json(401, { code: 'UNAUTHENTICATED' }));
    const lost = vi.fn();
    onAuthLost(lost);
    await expect(get('/me')).rejects.toBeInstanceOf(ApiError);
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/me', '/api/v1/auth/refresh']);
    expect(lost).toHaveBeenCalledOnce();
    expect(getTerminalToken(null)).toBe('good-token');
    onAuthLost(() => undefined);
  });
});
