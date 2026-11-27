import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../../branch-server/src/db/open';
import { adminAuth, startHq, type Hq } from './helpers';

// HQ staff accounts (docs/12 §21, P3d): people sign in with their own name and password and a role; every audit row says who; the break-glass
// token still works as an admin and is audited as such. HQ is reachable from the internet, so the sign-in is hardened (rate limit, lockout, no
// user enumeration, no secret in an answer or the audit).
let hq: Hq;
const api = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASS = 'a-long-first-password';
const STRONG = 'a-different-long-password';

const login = (username: string, password: string) => hq.http.post(`${api}/auth/login`).send({ username, password });
const makeUser = (username: string, role: string, password = PASS) =>
  hq.http
    .post(`${api}/users`)
    .set(adminAuth)
    .send({ username, name: `${username} person`, role, password });
/** An account that has already chosen its own password, signed in: returns its token. */
async function signedIn(username: string, role: string): Promise<string> {
  expect((await makeUser(username, role)).status).toBe(201);
  const first = await login(username, PASS);
  const changed = await hq.http.post(`${api}/auth/password`).set(bearer(first.body.token)).send({ current: PASS, password: STRONG });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  return changed.body.token as string;
}
const audit = () => {
  const db = openDatabase(hq.databasePath, { readonly: true });
  const rows = db.prepare('SELECT action, actor, detail_json FROM hq_audit ORDER BY id').all() as {
    action: string;
    actor: string | null;
    detail_json: string | null;
  }[];
  db.close();
  return rows;
};

beforeAll(async () => {
  hq = await startHq({ rateLimit: false });
});
afterAll(() => hq.close());

describe('making accounts', () => {
  it('an admin adds a person; the name is lower-case, unique, and the password is long enough (US-HQ-users)', async () => {
    const made = await makeUser('Maya.Admin', 'admin');
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ username: 'maya.admin', role: 'admin', active: true, mustResetPassword: true });
    expect(JSON.stringify(made.body)).not.toMatch(/password_hash|argon2|"password"/i);
    expect((await makeUser('MAYA.admin', 'viewer')).body.code).toBe('DUPLICATE_NAME');
    expect((await makeUser('short-pass', 'viewer', 'tooshort')).body.code).toBe('WEAK_PASSWORD');
    expect((await makeUser('x', 'viewer')).status).toBe(422); // name too short
    expect((await makeUser('bad name!', 'viewer')).status).toBe(422);
    expect((await makeUser('boss2', 'owner')).status).toBe(400); // not a role
  });

  it('nobody but an admin can make or list accounts', async () => {
    const catalog = await signedIn('cat.one', 'catalog');
    const viewer = await signedIn('view.one', 'viewer');
    for (const t of [catalog, viewer]) {
      expect((await hq.http.get(`${api}/users`).set(bearer(t))).status).toBe(403);
      expect(
        (await hq.http.post(`${api}/users`).set(bearer(t)).send({ username: 'nope1', name: 'n', role: 'admin', password: PASS })).status,
      ).toBe(403);
    }
  });
});

describe('signing in', () => {
  it('a new account must choose its own password before anything else, and the server enforces it', async () => {
    expect((await makeUser('newbie', 'catalog')).status).toBe(201);
    const first = await login('newbie', PASS);
    expect(first.status).toBe(200);
    expect(first.body.user.mustResetPassword).toBe(true);
    const t = first.body.token as string;
    expect((await hq.http.get(`${api}/auth/me`).set(bearer(t))).status).toBe(200); // allowed
    const blocked = await hq.http.get(`${api}/products`).set(bearer(t));
    expect([blocked.status, blocked.body.code]).toEqual([403, 'PASSWORD_RESET_REQUIRED']);
    expect(
      (await hq.http.post(`${api}/auth/password`).set(bearer(t)).send({ current: 'wrong-wrong-wrong', password: STRONG })).status,
    ).toBe(401);
    expect((await hq.http.post(`${api}/auth/password`).set(bearer(t)).send({ current: PASS, password: PASS })).body.code).toBe(
      'WEAK_PASSWORD',
    );
    const changed = await hq.http.post(`${api}/auth/password`).set(bearer(t)).send({ current: PASS, password: STRONG });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustResetPassword).toBe(false);
    expect((await hq.http.get(`${api}/products`).set(bearer(changed.body.token))).status).toBe(200);
    // the old session and the old password are gone
    expect((await hq.http.get(`${api}/auth/me`).set(bearer(t))).status).toBe(401);
    expect((await login('newbie', PASS)).status).toBe(401);
    expect((await login('newbie', STRONG)).status).toBe(200);
  });

  it('a wrong name, a wrong password and a closed account all answer the same', async () => {
    await signedIn('closed.one', 'viewer');
    const id = (await hq.http.get(`${api}/users`).set(adminAuth)).body.data.find(
      (u: { username: string }) => u.username === 'closed.one',
    ).id;
    await hq.http.patch(`${api}/users/${id}`).set(adminAuth).send({ active: false });
    const answers = [await login('nobody.here', STRONG), await login('closed.one', STRONG), await login('maya.admin', 'wrong-wrong-wrong')];
    for (const a of answers) expect([a.status, a.body.code]).toEqual([401, 'INVALID_CREDENTIALS']);
  });

  it('five wrong passwords lock the account for a while, even for the right password; an admin can reset it', async () => {
    const token = await signedIn('locky', 'viewer');
    expect(token).toBeTruthy();
    for (let i = 0; i < 5; i++) expect((await login('locky', 'wrong-wrong-wrong')).status).toBe(401);
    const locked = await login('locky', STRONG);
    expect([locked.status, locked.body.code]).toEqual([429, 'ACCOUNT_LOCKED']);
    const id = (await hq.http.get(`${api}/users`).set(adminAuth)).body.data.find((u: { username: string }) => u.username === 'locky').id;
    expect((await hq.http.post(`${api}/users/${id}/password`).set(adminAuth).send({ password: PASS })).status).toBe(204);
    expect((await login('locky', PASS)).status).toBe(200); // reset clears the lock (and asks for a new password)
    expect(audit().some((r) => r.action === 'user.locked')).toBe(true);
  });

  it('signing out ends the session', async () => {
    const t = await signedIn('leaver', 'viewer');
    expect((await hq.http.get(`${api}/branches`).set(bearer(t))).status).toBe(200);
    expect((await hq.http.post(`${api}/auth/logout`).set(bearer(t))).status).toBe(204);
    expect((await hq.http.get(`${api}/branches`).set(bearer(t))).status).toBe(401);
  });

  it('is rate limited when HQ runs in production mode', async () => {
    const limited = await startHq({ rateLimit: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 14; i++)
        codes.push((await limited.http.post(`${api}/auth/login`).send({ username: 'who', password: 'x'.repeat(12) })).status);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes).toContain(429);
    } finally {
      await limited.close();
    }
  });
});

describe('roles', () => {
  it('a viewer reads, a catalog person also changes the catalog, only an admin touches branches and people', async () => {
    const viewer = await signedIn('role.viewer', 'viewer');
    const catalog = await signedIn('role.catalog', 'catalog');
    const admin = await signedIn('role.admin', 'admin');
    const read = (t: string) => hq.http.get(`${api}/products`).set(bearer(t));
    const writeProduct = (t: string) =>
      hq.http
        .post(`${api}/products`)
        .set(bearer(t))
        .send({ name: `P ${Math.random()}`, priceMinor: 1000 });
    const writeBranch = (t: string) =>
      hq.http
        .post(`${api}/branches`)
        .set(bearer(t))
        .send({ code: `R${Math.floor(Math.random() * 1e6)}`.slice(0, 8), name: 'B' });
    for (const t of [viewer, catalog, admin]) expect((await read(t)).status).toBe(200);
    expect((await writeProduct(viewer)).status).toBe(403);
    expect((await writeProduct(catalog)).status).toBe(201);
    expect((await writeProduct(admin)).status).toBe(201);
    expect((await hq.http.post(`${api}/exchange-rates`).set(bearer(viewer)).send({ rateLbpPerUsd: 90000 })).status).toBe(403);
    expect((await hq.http.post(`${api}/exchange-rates`).set(bearer(catalog)).send({ rateLbpPerUsd: 90000 })).status).toBe(201);
    expect((await writeBranch(catalog)).status).toBe(403);
    expect((await writeBranch(admin)).status).toBe(201);
    expect((await hq.http.get(`${api}/branches`).set(bearer(viewer))).status).toBe(200);
  });

  it('a changed role or a closed account takes effect at once', async () => {
    const t = await signedIn('shifty', 'admin');
    expect((await hq.http.get(`${api}/users`).set(bearer(t))).status).toBe(200);
    const id = (await hq.http.get(`${api}/users`).set(adminAuth)).body.data.find((u: { username: string }) => u.username === 'shifty').id;
    await hq.http.patch(`${api}/users/${id}`).set(adminAuth).send({ role: 'viewer' });
    expect((await hq.http.get(`${api}/users`).set(bearer(t))).status).toBe(401); // the old session is closed: sign in again
    const again = await login('shifty', STRONG);
    expect((await hq.http.get(`${api}/users`).set(bearer(again.body.token))).status).toBe(403);
  });

  it('HQ always keeps one active admin', async () => {
    const users = (await hq.http.get(`${api}/users`).set(adminAuth)).body.data as {
      id: number;
      role: string;
      username: string;
      active: boolean;
    }[];
    const admins = users.filter((u) => u.role === 'admin' && u.active);
    for (const a of admins.slice(0, -1))
      expect((await hq.http.patch(`${api}/users/${a.id}`).set(adminAuth).send({ active: false })).status).toBe(200);
    const last = admins[admins.length - 1]!;
    for (const patch of [{ active: false }, { role: 'viewer' }]) {
      const r = await hq.http.patch(`${api}/users/${last.id}`).set(adminAuth).send(patch);
      expect([r.status, r.body.code]).toEqual([409, 'LAST_ADMIN']);
    }
  });
});

describe('the audit log says who, and never a secret', () => {
  it('a change by a person is recorded under their name, by the break-glass token as `token`, and by a branch enrolling as nobody', async () => {
    const t = await signedIn('auditor.cat', 'catalog');
    await hq.http.post(`${api}/categories`).set(bearer(t)).send({ name: 'Audited by a person' });
    await hq.http.post(`${api}/categories`).set(adminAuth).send({ name: 'Audited by the token' });
    const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'AUD', name: 'Audit' })).body.enrolCode as string;
    expect((await hq.http.post(`${api}/sync/enrol`).send({ code })).status).toBe(200);
    const rows = audit();
    expect(rows.find((r) => r.action === 'category.create' && r.detail_json?.includes('Audited by a person'))?.actor).toBe(
      'user:auditor.cat',
    );
    expect(rows.find((r) => r.action === 'category.create' && r.detail_json?.includes('Audited by the token'))?.actor).toBe('token');
    const enrol = rows.filter((r) => r.action === 'branch.enrol');
    expect(enrol.length).toBeGreaterThan(0);
    expect(enrol.every((r) => r.actor === null)).toBe(true); // a stale name is never left behind
  });

  it('no password, hash or token is in the audit, in an answer, or in the database in plain', async () => {
    const dump = JSON.stringify(audit());
    for (const secret of [PASS, STRONG, 'argon2']) expect(dump).not.toContain(secret);
    const db = openDatabase(hq.databasePath, { readonly: true });
    const stored = JSON.stringify(db.prepare('SELECT password_hash FROM hq_users').all());
    const sessions = (db.prepare('SELECT token_hash FROM hq_sessions').all() as { token_hash: string }[]).map((r) => r.token_hash);
    db.close();
    expect(stored).toContain('$argon2id$');
    expect(stored).not.toContain(PASS);
    const token = (await login('maya.admin', 'wrong-wrong-wrong')).body.token;
    expect(token).toBeUndefined();
    expect(sessions.length).toBeGreaterThan(0);
    for (const h of sessions) expect(h).toMatch(/^[0-9a-f]{64}$/); // only a sha256 is kept, never the token
  });
});
