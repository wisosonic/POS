import { clearSession, getToken } from './session';

// One way to talk to HQ: the session token goes in the Authorization header, a failure is an ApiError carrying HQ's stable `code`, and a sign-in that HQ no
// longer accepts (expired, signed out elsewhere, role changed) sends the person back to the sign-in page.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Problem = { code?: string; detail?: string; title?: string };

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { auth?: boolean; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const token = getToken();
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', 'HQ could not be reached. Check the connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const p = (data ?? {}) as Problem;
    // A sign-in HQ does not accept any more: back to the sign-in page. (A wrong password at the sign-in itself is a 401 too, and stays on that page.)
    if (res.status === 401 && opts.auth !== false && token) {
      clearSession();
      window.dispatchEvent(new Event('hq-signed-out'));
    }
    throw new ApiError(res.status, p.code ?? 'ERROR', p.detail ?? p.title ?? `HQ answered ${res.status}`);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);

/** A POST that must happen once however many times it is sent (a payment): the key is the same for the same attempt. */
export const postOnce = <T>(path: string, body: unknown, key: string) =>
  api<T>('POST', path, body, { headers: { 'Idempotency-Key': key } });
