import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { adminAuth, startHq, type Hq } from '../central/helpers';
import { startCtx, type TestCtx } from '../helpers/app';

// A branch server and the HQ server, both real, talking over HTTP (docs/12-sync-and-hq.md P2a): connecting a branch with a one-time code,
// and the loop that notices HQ going away and coming back, with nobody doing anything.
let hq: Hq;
let c: TestCtx;
let admin: string;
let cashier: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const status = async () => (await c.http.get(`${api}/sync/status`).set(auth(admin))).body;
const until = async (check: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
};
const newBranchCode = async (code: string, name = 'Hamra') =>
  (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name })).body.enrolCode as string;

beforeAll(async () => {
  hq = await startHq();
  // The branch's loop is ON here, and fast, so an outage and a recovery take a fraction of a second to notice.
  c = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], refusedRetryMs: 150, idleMs: 40 } });
  admin = await c.login('admin');
  cashier = await c.login('cashier');
});
afterEach(async () => {
  await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
});
afterAll(async () => {
  await c.close();
  await hq.close();
});

describe('connecting a branch to HQ (Settings > HQ)', () => {
  it('starts out not connected, which is the shop as it always was', async () => {
    const s = await status();
    expect(s).toMatchObject({ linked: false, state: 'unlinked', hqUrl: null, branch: null });
  });

  it('only an admin may connect, look at the link or disconnect', async () => {
    for (const [method, path] of [
      ['get', '/sync/status'],
      ['post', '/sync/connect'],
      ['post', '/sync/disconnect'],
    ] as const) {
      expect((await c.http[method](`${api}${path}`).send({})).status, `${path} anonymous`).toBe(401);
      expect((await c.http[method](`${api}${path}`).set(auth(cashier)).send({})).status, `${path} cashier`).toBe(403);
    }
  });

  it('refuses an address that is not one, and a wrong or used code', async () => {
    const connect = (body: Record<string, unknown>) => c.http.post(`${api}/sync/connect`).set(auth(admin)).send(body);
    expect((await connect({ url: 'not an address', code: 'AAAAA-BBBBB' })).status).toBe(400);
    expect((await connect({ url: 'ftp://hq.example.com', code: 'AAAAA-BBBBB' })).status).toBe(400);
    expect((await connect({ url: 'https://user:pw@hq.example.com', code: 'AAAAA-BBBBB' })).status).toBe(400);
    const wrong = await connect({ url: hq.url, code: 'AAAAA-BBBBB' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('ENROL_CODE_INVALID');
    const code = await newBranchCode('B7');
    expect((await connect({ url: hq.url, code })).status).toBe(200);
    expect((await connect({ url: hq.url, code })).status).toBe(422); // single use
  });

  it('says so plainly when HQ cannot be reached at that address', async () => {
    const res = await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: 'http://127.0.0.1:1', code: 'AAAAA-BBBBB' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('HQ_UNREACHABLE');
  });

  it('connects with the one-time code: the branch takes HQ’s code and name, and starts talking to HQ', async () => {
    const code = await newBranchCode('B8', 'Verdun');
    const res = await c.http
      .post(`${api}/sync/connect`)
      .set(auth(admin))
      .send({ url: `${hq.url}/`, code });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: true, hqUrl: hq.url, branch: { code: 'B8', name: 'Verdun' } });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    // the local branch row, printed on receipts later, now carries HQ's code and name
    expect((await c.http.get(`${api}/terminals`).set(auth(admin))).body.data[0].branch).toMatchObject({ code: 'B8', name: 'Verdun' });
    // and HQ has heard from it
    const seen = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'B8');
    expect(seen).toMatchObject({ connected: true });
  });

  it('never shows the branch token: not in the status, not in a response, not in the audit log', async () => {
    const code = await newBranchCode('B9');
    const res = await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code });
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    expect(Object.keys(await status()).sort()).toEqual(
      ['branch', 'connectedAt', 'hqUrl', 'lastError', 'lastOkAt', 'linked', 'since', 'state'].sort(),
    );
    const audit = (await c.http.get(`${api}/audit?action=hq.connect`).set(auth(admin))).body.data;
    expect(audit.length).toBeGreaterThan(0);
    const all = JSON.stringify(audit);
    expect(all).not.toMatch(/[A-Za-z0-9_-]{40,}/); // no token-sized secret
    expect(all).not.toContain(code);
  });

  it('disconnecting goes back to working alone, at once', async () => {
    await c.http
      .post(`${api}/sync/connect`)
      .set(auth(admin))
      .send({ url: hq.url, code: await newBranchCode('B10') });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    const res = await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
    expect(res.body).toMatchObject({ linked: false, hqUrl: null });
    expect(await until(async () => (await status()).state === 'unlinked')).toBe(true);
  });
});

describe('the loop notices an outage and a recovery by itself', () => {
  it('goes offline when HQ goes away, and comes back online when HQ does, with nobody doing anything', async () => {
    const code = await newBranchCode('B11', 'Jounieh');
    await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);

    // HQ goes down (power cut, internet out): the branch notices and says why.
    const { databasePath, port } = hq;
    await hq.stop();
    expect(await until(async () => (await status()).state === 'offline')).toBe(true);
    expect((await status()).lastError).toMatch(/reach|answer/i);
    // The shop is not affected: selling still works while HQ is away.
    await c.openRegister(cashier);
    const sale = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', crypto.randomUUID()).send(c.newSaleBody());
    expect(sale.status).toBe(201);

    // HQ comes back on the same address with the same data: the branch finds it on its own and is online again.
    const back = await startHq({ databasePath, port });
    hq = back;
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    expect((await status()).lastError).toBeNull();
  });

  it('tells the screens when the state changes (a hint on the live-updates stream)', async () => {
    const heard: string[] = [];
    const stop = c.app.events.subscribe((e) => heard.push(e.type));
    await c.http
      .post(`${api}/sync/connect`)
      .set(auth(admin))
      .send({ url: hq.url, code: await newBranchCode('B12') });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
    expect(await until(async () => (await status()).state === 'unlinked')).toBe(true);
    stop();
    expect(heard.filter((t) => t === 'sync.changed').length).toBeGreaterThanOrEqual(2);
  });

  it('when HQ revokes the branch the loop says so and stops hammering HQ, and a new code connects it again', async () => {
    const code = await newBranchCode('B13', 'Saida');
    await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);

    const id = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'B13').id;
    await hq.http.post(`${api}/branches/${id}/revoke`).set(adminAuth);
    expect(await until(async () => (await status()).state === 'refused')).toBe(true);
    expect((await status()).lastError).toMatch(/no longer accepts/i);

    const fresh = (await hq.http.post(`${api}/branches/${id}/enrol-code`).set(adminAuth)).body.enrolCode as string;
    await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: fresh });
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
  });
});

describe('shutting down', () => {
  it('a branch server whose loop is running closes at once, even while HQ is unreachable', async () => {
    const own = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
    const owner = await own.login('admin');
    const aHq = await startHq();
    const code = (await aHq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'B20', name: 'Zahle' })).body.enrolCode as string;
    await own.http.post(`${api}/sync/connect`).set(auth(owner)).send({ url: aHq.url, code });
    await aHq.stop(); // HQ is gone: the loop is now busy failing and waiting
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(3000);
    await aHq.close();
  }, 20_000);
});
