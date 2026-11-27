import { AppError } from '../../errors';

// The branch server's calls to HQ (docs/12-sync-and-hq.md §6-7). Over a bad connection every one of them can fail in the ordinary way;
// none of them throws for that: they answer with what happened, and the caller decides what it means.

export type HqBranch = { id: number; code: string; name: string; kind: 'sale' | 'stock' };

/** Accept an HQ address like `https://hq.example.com` or `http://127.0.0.1:4000`. Only the address itself: no sign-in in the URL, no path. */
export function normaliseHqUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new AppError(400, 'VALIDATION', 'That is not an address. Use something like https://hq.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new AppError(400, 'VALIDATION', 'The HQ address must start with https:// (or http:// for a test)');
  if (u.username || u.password) throw new AppError(400, 'VALIDATION', 'Do not put a name or password in the address');
  return u.origin;
}

type Fetch = typeof fetch;

/** Trade the one-time code for the branch's token. Throws an AppError the screen can show. */
export async function enrolAtHq(hqUrl: string, code: string, fetchImpl: Fetch = fetch): Promise<{ token: string; branch: HqBranch }> {
  let res: Response;
  try {
    res = await fetchImpl(`${hqUrl}/api/v1/sync/enrol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError(502, 'HQ_UNREACHABLE', 'Cannot reach HQ at that address. Check the address and the internet connection.');
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; branch?: HqBranch; code?: string; detail?: string };
  // An HQ older than the branch kinds does not say: every branch was a sale branch then.
  if (res.ok && body.token && body.branch) return { token: body.token, branch: { ...body.branch, kind: body.branch.kind ?? 'sale' } };
  if (res.status === 422)
    throw new AppError(422, 'ENROL_CODE_INVALID', body.detail ?? 'That code is wrong, already used or has expired. Ask HQ for a new one.');
  throw new AppError(502, 'HQ_REFUSED', `HQ did not accept the connection (${res.status}).`);
}

export type PingResult =
  | {
      ok: true;
      serverTime: string;
      branch: HqBranch;
      /** HQ's latest change number; absent from an older HQ (then the branch always pulls). */ changeSeq?: number;
    }
  /** HQ does not accept this branch any more (its token was revoked, or the branch was switched off). Retrying will not help. */
  | { ok: false; refused: true; error: string }
  /** The connection, or HQ, is down. Try again later. */
  | { ok: false; refused: false; error: string };

export async function pingHq(hqUrl: string, token: string, signal: AbortSignal, fetchImpl: Fetch = fetch): Promise<PingResult> {
  try {
    const res = await fetchImpl(`${hqUrl}/api/v1/sync/ping`, {
      headers: { 'X-Branch-Token': token, Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (res.status === 401)
      return { ok: false, refused: true, error: 'HQ no longer accepts this branch. Ask HQ for a new code and connect again.' };
    if (!res.ok) return { ok: false, refused: false, error: `HQ answered ${res.status}` };
    const body = (await res.json()) as { serverTime: string; branch: HqBranch; changeSeq?: unknown };
    const changeSeq = Number.isSafeInteger(body.changeSeq) ? (body.changeSeq as number) : undefined;
    return { ok: true, serverTime: body.serverTime, branch: body.branch, changeSeq };
  } catch (e) {
    return {
      ok: false,
      refused: false,
      error: e instanceof Error && e.name === 'TimeoutError' ? 'HQ did not answer in time' : 'Cannot reach HQ',
    };
  }
}
