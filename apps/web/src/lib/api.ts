// The one place the till talks to the server. The access token lives in memory only (never in storage a script could read);
// the refresh token is an httpOnly cookie the browser sends by itself.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
  /** The server could not be reached at all: offline, or the API is restarting. */
  get isNetwork() {
    return this.status === 0;
  }
}

let accessToken: string | null = null;
let onSessionLost: () => void = () => undefined;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const onAuthLost = (fn: () => void) => {
  onSessionLost = fn;
};

type Options = { idempotencyKey?: string; noRefresh?: boolean; signal?: AbortSignal };

async function send(method: string, path: string, body: unknown, opts: Options): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // A file (a product picture) goes as it is, with its own type; everything else is JSON.
  const file = body instanceof Blob ? body : null;
  if (body !== undefined) headers['Content-Type'] = file ? file.type || 'application/octet-stream' : 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  try {
    return await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : (file ?? JSON.stringify(body)),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server');
  }
}

let refreshing: Promise<boolean> | null = null;
/** Trade the refresh cookie for a new access token. One attempt at a time, however many requests ask. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await send('POST', '/auth/refresh', undefined, { noRefresh: true });
      if (!res.ok) return false;
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  let p: { code?: string; detail?: string } & Record<string, unknown> = {};
  try {
    p = await res.json();
  } catch {
    /* not JSON */
  }
  const { code, detail, type: _t, title: _ti, status: _s, ...extra } = p;
  return new ApiError(res.status, code ?? `HTTP_${res.status}`, detail ?? res.statusText, extra);
}

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: Options = {},
): Promise<T> {
  let res = await send(method, path, body, opts);
  if (res.status === 401 && !opts.noRefresh) {
    if (await refreshSession()) res = await send(method, path, body, opts);
    else {
      onSessionLost();
      throw await toError(res);
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : await res.text()) as T;
}

export const get = <T>(path: string, opts?: Options) => api<T>('GET', path, undefined, opts);
export const post = <T>(path: string, body?: unknown, opts?: Options) => api<T>('POST', path, body ?? {}, opts);
export const patch = <T>(path: string, body: unknown, opts?: Options) => api<T>('PATCH', path, body, opts);
