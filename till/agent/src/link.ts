// The till's link monitor (docs/14-connection-and-till-backend.md §2 to §4). A little loop that asks the branch server "are you there?"
// every few seconds, and tells the screens whether selling must stop. It is the heartbeat; the same answer also carries the version of
// each topic the till keeps a copy of (step 3 uses that). It decides nothing about money and reads no business data.
//
//  - With the till's device token it calls `GET /api/v1/ping` (token-guarded, docs/06). Without one (a shop still in legacy
//    single-till mode, or a till not enrolled yet) it calls the open `GET /api/v1/healthz`, which only proves the server is there.
//  - One missed answer is not an outage: a slow reply must not make the till flicker. After `missesToFail` in a row (default 2) the
//    state is `down` and selling stops. The first good answer after that puts it back to `connected` at once.
//  - A server that answers "I do not know this device" is reachable, so selling is not stopped by the link: the screens already
//    offer to enrol the device (`not_a_till`).

export type LinkState = 'starting' | 'connected' | 'down' | 'not_a_till' | 'not_configured';

export type LinkSnapshot = {
  state: LinkState;
  /** True while selling must stop: the branch server has not answered `missesToFail` times in a row. */
  blocked: boolean;
  /** When the state last changed. */
  since: string;
  lastOkAt: string | null;
  misses: number;
  /** Why the last attempt failed (TIMEOUT, REFUSED, UNKNOWN_NAME, UNREACHABLE, BAD_ANSWER, HOST_NOT_ALLOWED), or null. */
  reason: string | null;
  detail: string | null;
  /** Which call is being used: the token-guarded ping, or the open health check. */
  watching: 'ping' | 'healthz' | null;
  serverTime: string | null;
  epoch: string | null;
  versions: Record<string, number> | null;
};

export type LinkOptions = {
  /** The branch server's address now, or null when none is set. */
  branchServer: () => string | null;
  intervalMs?: number;
  timeoutMs?: number;
  missesToFail?: number;
  log?: (message: string) => void;
};

export type LinkMonitor = {
  start(): void;
  stop(): void;
  /** The device token to ping with (null: use the open health check). A different token pings again at once. */
  setToken(token: string | null): void;
  /** Ask now (the loop does this by itself). Resolves when that one attempt is finished. */
  check(): Promise<void>;
  snapshot(): LinkSnapshot;
};

const REASONS: Record<string, string> = {
  TIMEOUT: 'Nothing answered in time: check that the branch server PC is on and on the network',
  REFUSED: 'The PC answered but no branch server is running on that port',
  UNKNOWN_NAME: 'That server name is not known on this network',
  UNREACHABLE: 'Cannot reach the branch server',
  BAD_ANSWER: 'Something answered, but not a branch server',
  HOST_NOT_ALLOWED: 'The branch server does not accept this address: add it to ALLOWED_HOSTS there',
};

function reasonOf(e: unknown): string {
  const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
  const name = (e as Error).name;
  if (name === 'TimeoutError' || name === 'AbortError' || cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
  if (cause === 'ENOTFOUND') return 'UNKNOWN_NAME';
  if (cause === 'ECONNREFUSED') return 'REFUSED';
  return 'UNREACHABLE';
}

export function createLinkMonitor(opts: LinkOptions): LinkMonitor {
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const missesToFail = opts.missesToFail ?? 2;
  const log = opts.log ?? (() => undefined);

  let token: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = true;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;

  const now = () => new Date().toISOString();
  let snap: LinkSnapshot = {
    state: 'starting',
    blocked: false,
    since: now(),
    lastOkAt: null,
    misses: 0,
    reason: null,
    detail: null,
    watching: null,
    serverTime: null,
    epoch: null,
    versions: null,
  };

  function set(state: LinkState, patch: Partial<LinkSnapshot>): void {
    if (state !== snap.state) {
      log(`Branch server link: ${snap.state} -> ${state}${patch.reason ? ` (${patch.reason})` : ''}`);
      snap = { ...snap, since: now() };
    }
    snap = { ...snap, ...patch, state, blocked: state === 'down' };
  }

  function good(patch: Partial<LinkSnapshot>, state: LinkState = 'connected'): void {
    set(state, { lastOkAt: now(), misses: 0, reason: null, detail: null, ...patch });
  }

  function miss(reason: string): void {
    const misses = snap.misses + 1;
    const detail = REASONS[reason] ?? null;
    // Until the threshold is reached the state stays what it was (a till that was working keeps working through one slow answer).
    if (misses >= missesToFail) set('down', { misses, reason, detail });
    else snap = { ...snap, misses, reason, detail };
  }

  async function attempt(): Promise<void> {
    const base = opts.branchServer();
    if (!base) {
      set('not_configured', { misses: 0, reason: null, detail: 'No branch server address is set yet', watching: null });
      return;
    }
    const usingToken = token;
    const path = usingToken ? '/api/v1/ping' : '/api/v1/healthz';
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        headers: usingToken ? { 'X-Terminal-Token': usingToken, Accept: 'application/json' } : { Accept: 'application/json' },
        signal: controller.signal,
      });
      const watching = usingToken ? 'ping' : 'healthz';
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        if (usingToken) {
          if (body.ok !== true) return miss('BAD_ANSWER');
          return good({
            watching,
            serverTime: typeof body.serverTime === 'string' ? body.serverTime : null,
            epoch: typeof body.epoch === 'string' ? body.epoch : null,
            versions: (body.versions as Record<string, number> | undefined) ?? null,
          });
        }
        return good({ watching, serverTime: null, epoch: null, versions: null });
      }
      const code = typeof body.code === 'string' ? body.code : '';
      if (res.status === 401 && (code === 'TERMINAL_UNKNOWN' || code === 'TERMINAL_REQUIRED'))
        return good({ watching, serverTime: null, epoch: null, versions: null }, 'not_a_till');
      if (code === 'HOST_NOT_ALLOWED') return miss('HOST_NOT_ALLOWED');
      return miss('BAD_ANSWER');
    } catch (e) {
      miss(reasonOf(e));
    } finally {
      clearTimeout(timeout);
      controller = null;
    }
  }

  /** One attempt at a time: a check asked for while one is running waits for that one. */
  function check(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = attempt()
      .catch((e: unknown) => log(`Link check failed unexpectedly: ${(e as Error).message}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void check().finally(schedule);
    }, intervalMs);
    timer.unref();
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      void check().finally(schedule);
    },
    stop() {
      stopped = true;
      running = false;
      clearTimeout(timer);
      controller?.abort();
    },
    setToken(next) {
      if (next === token) return;
      token = next;
      // A different identity means a different question (ping or health check): do not wait for the next round.
      if (running) void Promise.resolve(inFlight).then(() => check());
    },
    check,
    snapshot: () => ({ ...snap, versions: snap.versions ? { ...snap.versions } : null }),
  };
}
