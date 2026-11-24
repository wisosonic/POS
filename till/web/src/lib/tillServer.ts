// The till's own server (till/agent, docs/11-multi-branch.md §8.4) keeps the one setting a till needs: where its branch server is.
// These calls go to the till's server itself (`/till/...`), NOT to the branch server, so they work when the branch server cannot be
// reached (that is when someone needs them). A web app served by the branch server directly has no such server: `getTillConfig`
// then answers null and the screen says there is nothing to set.

export type TillConfig = { branchServer: string | null; source: 'saved' | 'environment' | null };
export type TestResult = { ok: boolean; url?: string; ms?: number; reason?: string; detail?: string };

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** The saved branch server address, or null when this app is not served by a till's own server. */
export async function getTillConfig(): Promise<TillConfig | null> {
  try {
    const res = await fetch('/till/config', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const body = (await res.json()) as Partial<TillConfig>;
    return 'branchServer' in body ? (body as TillConfig) : null;
  } catch {
    return null;
  }
}

/** Save the address. A refusal throws an Error whose message says what is wrong with it. */
export async function saveTillConfig(branchServer: string): Promise<TillConfig> {
  const res = await fetch('/till/config', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ branchServer }) });
  const body = (await res.json().catch(() => ({}))) as Partial<TillConfig> & { detail?: string };
  if (!res.ok) throw new Error(body.detail ?? `The till answered ${res.status}`);
  return body as TillConfig;
}

/** Try an address (or, with none given, the saved one): does a branch server answer there? */
export async function testBranchServer(branchServer?: string): Promise<TestResult> {
  try {
    const res = await fetch('/till/test', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ branchServer }) });
    return (await res.json()) as TestResult;
  } catch {
    return { ok: false, reason: 'TILL_DOWN', detail: 'The till program on this PC does not answer' };
  }
}
