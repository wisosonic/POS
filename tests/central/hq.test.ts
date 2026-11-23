import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../../packages/core/src/open';
import { loadCentralConfig } from '../../apps/central/src/config';
import { ADMIN_TOKEN, adminAuth, branchAuth, startHq, type Hq } from './helpers';

// The HQ server (docs/12-sync-and-hq.md P2a): branches, enrolment by one-time code, branch tokens, and "are you there?".
let hq: Hq;
const api = '/api/v1';

const addBranch = (code: string, name = `Branch ${code}`) => hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name });
const enrol = (code: string) => hq.http.post(`${api}/sync/enrol`).send({ code });
const ping = (token: string) => hq.http.get(`${api}/sync/ping`).set(branchAuth(token));
const readDb = () => openDatabase(hq.databasePath, { readonly: true });

beforeAll(async () => {
  hq = await startHq();
});
afterAll(() => hq.close());

describe('HQ staff', () => {
  it('is alive without a sign-in, and shows nothing else', async () => {
    const res = await hq.http.get(`${api}/healthz`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('every branch call needs the HQ admin token: none, a wrong one and a branch token are all refused', async () => {
    expect((await hq.http.get(`${api}/branches`)).status).toBe(401);
    expect((await hq.http.get(`${api}/branches`).set({ Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await hq.http.get(`${api}/branches`).set({ Authorization: `Basic ${ADMIN_TOKEN}` })).status).toBe(401);
    expect((await hq.http.post(`${api}/branches`).send({ code: 'X', name: 'X' })).status).toBe(401);
    expect((await hq.http.get(`${api}/branches`).set(adminAuth)).status).toBe(200);
  });

  it('adds a branch, with a one-time code shown once; the list never shows a code', async () => {
    const res = await addBranch('b2', 'Hamra');
    expect(res.status).toBe(201);
    expect(res.body.branch).toMatchObject({ code: 'B2', name: 'Hamra' }); // the code is upper-cased
    expect(res.body.enrolCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const list = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'B2', active: true, connected: false, enrolPending: true });
    expect(JSON.stringify(list)).not.toContain(res.body.enrolCode);
  });

  it('refuses a duplicate code, and a code that is not 1-8 letters or digits', async () => {
    expect((await addBranch('B2')).status).toBe(409);
    expect((await addBranch('b-2')).status).toBe(400);
    expect((await addBranch('TOOLONGCODE')).status).toBe(400);
    expect((await addBranch('')).status).toBe(400);
  });
});

describe('connecting a branch', () => {
  let code = '';
  let token = '';

  it('a branch trades the one-time code for its token, once', async () => {
    code = (await addBranch('B3', 'Verdun')).body.enrolCode;
    const done = await enrol(code.toLowerCase().replace('-', ' ')); // typed off a screen: case, a space and the dash do not matter
    expect(done.status).toBe(200);
    expect(done.body.branch).toMatchObject({ code: 'B3', name: 'Verdun' });
    token = done.body.token;
    expect(token.length).toBeGreaterThan(30);
    expect((await enrol(code)).status).toBe(422); // single use
    expect((await enrol(code)).body.code).toBe('ENROL_CODE_INVALID');
  });

  it('refuses a wrong code and an expired one', async () => {
    expect((await enrol('AAAAA-BBBBB')).status).toBe(422);
    const fresh = (await addBranch('B4')).body.enrolCode as string;
    const db = openDatabase(hq.databasePath);
    db.prepare(`UPDATE branches SET enrol_expires_at = '2020-01-01T00:00:00.000Z' WHERE code = 'B4'`).run();
    db.close();
    expect((await enrol(fresh)).status).toBe(422);
  });

  it('"are you there?" answers a connected branch, and nobody else', async () => {
    const ok = await ping(token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, branch: { code: 'B3' } });
    expect(Date.parse(ok.body.serverTime)).not.toBeNaN();
    expect((await hq.http.get(`${api}/sync/ping`)).status).toBe(401);
    const unknown = await ping('not-a-token');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('BRANCH_UNKNOWN');
    expect((await hq.http.get(`${api}/sync/ping`).set(adminAuth)).status).toBe(401); // the admin token is not a branch's
  });

  it('keeps track of when each branch was last heard from', async () => {
    const branch = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'B3');
    expect(branch).toMatchObject({ connected: true, enrolPending: false });
    expect(Date.parse(branch.lastSeenAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a branch can only be told apart by its own token', async () => {
    const other = (await addBranch('B5', 'Jounieh')).body.enrolCode;
    const otherToken = (await enrol(other)).body.token as string;
    expect((await ping(otherToken)).body.branch.code).toBe('B5');
    expect((await ping(token)).body.branch.code).toBe('B3');
  });

  it('revoking a branch stops its token at once; a new code connects it again with a new token', async () => {
    const id = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'B3').id;
    expect((await hq.http.post(`${api}/branches/${id}/revoke`).send()).status).toBe(401); // staff only
    expect((await hq.http.post(`${api}/branches/${id}/revoke`).set(adminAuth)).status).toBe(204);
    expect((await ping(token)).status).toBe(401);

    const again = await hq.http.post(`${api}/branches/${id}/enrol-code`).set(adminAuth);
    const fresh = (await enrol(again.body.enrolCode)).body.token as string;
    expect(fresh).not.toBe(token);
    expect((await ping(fresh)).status).toBe(200);
    expect((await ping(token)).status).toBe(401);
    token = fresh;
  });

  it('a switched-off branch cannot connect or ping, and switching it on again restores it', async () => {
    const id = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'B3').id;
    expect((await hq.http.patch(`${api}/branches/${id}`).set(adminAuth).send({ active: false })).body.data.active).toBe(false);
    expect((await ping(token)).status).toBe(401);
    expect((await hq.http.post(`${api}/branches/${id}/enrol-code`).set(adminAuth)).status).toBe(422);
    await hq.http.patch(`${api}/branches/${id}`).set(adminAuth).send({ active: true, name: 'Verdun (new)' });
    expect((await ping(token)).status).toBe(200);
  });

  it('an unknown branch id is a 404', async () => {
    expect((await hq.http.post(`${api}/branches/9999/revoke`).set(adminAuth)).status).toBe(404);
    expect((await hq.http.post(`${api}/branches/9999/enrol-code`).set(adminAuth)).status).toBe(404);
    expect((await hq.http.patch(`${api}/branches/9999`).set(adminAuth).send({ name: 'x' })).status).toBe(404);
  });
});

describe('what HQ writes down', () => {
  it('audits every change to a branch, and never a code or a token', async () => {
    const db = readDb();
    const rows = db.prepare('SELECT action, detail_json FROM hq_audit ORDER BY id').all() as {
      action: string;
      detail_json: string | null;
    }[];
    db.close();
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['branch.create', 'branch.enrol', 'branch.revoke', 'branch.enrol-code', 'branch.update']),
    );
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/[A-Z2-9]{5}-[A-Z2-9]{5}/); // no one-time code
    expect(all).not.toMatch(/[A-Za-z0-9_-]{40,}/); // no token-sized secret
  });

  it('the audit log cannot be changed or deleted', () => {
    const db = openDatabase(hq.databasePath);
    expect(() => db.prepare(`UPDATE hq_audit SET action = 'x'`).run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM hq_audit').run()).toThrow(/append-only/);
    db.close();
  });

  it('stores only hashes: no code and no token is in the database', async () => {
    const code = (await addBranch('B6')).body.enrolCode as string;
    const token = (await enrol(code)).body.token as string;
    const db = readDb();
    const dump = JSON.stringify(db.prepare('SELECT * FROM branches').all());
    db.close();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(code.replace('-', ''));
  });
});

describe('protecting HQ itself (it is the first part reachable from the internet)', () => {
  const OPEN = new Set(['GET /api/v1/healthz', 'POST /api/v1/sync/enrol']);
  const real = () => hq.app.registeredRoutes.filter((r) => r.url.startsWith(api) && !['HEAD', 'OPTIONS'].includes(r.method));
  const concrete = (url: string) => url.replace(/:\w+/g, '1');

  it('the list of routes is really there, so the checks below cannot pass by checking nothing', () => {
    expect(real().length).toBeGreaterThanOrEqual(7);
    for (const open of OPEN) expect(real().map((r) => `${r.method} ${r.url}`)).toContain(open);
  });

  it('every other route refuses an anonymous request and a garbage token: only the two listed doors are open', async () => {
    const open: string[] = [];
    for (const r of real()) {
      if (OPEN.has(`${r.method} ${r.url}`)) continue;
      const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
      for (const headers of [{}, { Authorization: 'Bearer nope', 'X-Branch-Token': 'nope' }]) {
        const res = await hq.http[method](concrete(r.url)).set(headers).send({});
        if (res.status !== 401) open.push(`${r.method} ${r.url} → ${res.status}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('refuses a request for a name that is not HQ’s (DNS rebinding) and one from another website', async () => {
    const wrongHost = await hq.http.get(`${api}/healthz`).set('Host', 'evil.example.com');
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body.code).toBe('HOST_NOT_ALLOWED');
    const wrongOrigin = await hq.http.get(`${api}/healthz`).set('Origin', 'https://evil.example.com');
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('answers to a public name only when it is listed', async () => {
    const named = await startHq({ allowedHosts: ['hq.darwish.example'] });
    expect((await named.http.get(`${api}/healthz`).set('Host', 'hq.darwish.example')).status).toBe(200);
    expect((await named.http.get(`${api}/healthz`).set('Host', 'other.example')).status).toBe(403);
    await named.close();
  });

  it('every answer forbids caching, framing and sniffing', async () => {
    const res = await hq.http.get(`${api}/healthz`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('limits how fast a code can be guessed on the open door (when the limits are on)', async () => {
    const limited = await startHq({ rateLimit: true });
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await limited.http.post(`${api}/sync/enrol`).send({ code: 'AAAAA-BBBBB' })).status);
    expect(codes.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(codes.slice(10).every((s) => s === 429)).toBe(true);
    await limited.close();
  });
});

describe('HQ configuration', () => {
  it('refuses to start without a real admin token', () => {
    expect(() => loadCentralConfig({})).toThrow(/HQ_ADMIN_TOKEN/);
    expect(() => loadCentralConfig({ HQ_ADMIN_TOKEN: 'short' })).toThrow(/at least 24/);
  });

  it('listens on localhost by default, reads its names and port, and refuses a bad port', () => {
    const c = loadCentralConfig({ HQ_ADMIN_TOKEN: ADMIN_TOKEN });
    expect(c).toMatchObject({ host: '127.0.0.1', port: 4000, production: false, allowedHosts: [] });
    const p = loadCentralConfig({
      HQ_ADMIN_TOKEN: ADMIN_TOKEN,
      HOST: '0.0.0.0',
      PORT: '8443',
      ALLOWED_HOSTS: ' HQ.Example , other ',
      NODE_ENV: 'production',
    });
    expect(p).toMatchObject({ host: '0.0.0.0', port: 8443, production: true, allowedHosts: ['hq.example', 'other'] });
    expect(() => loadCentralConfig({ HQ_ADMIN_TOKEN: ADMIN_TOKEN, PORT: 'abc' })).toThrow(/PORT/);
  });
});
