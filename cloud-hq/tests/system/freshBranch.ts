import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { buildApp } from '../../../branch-server/src/app';
import { migrate } from '../../../branch-server/src/db/migrate';
import { seedReference } from '../../../branch-server/src/db/seed';
import { openDatabase } from '../../../branch-server/src/db/open';
import { hashPassword } from '../../../branch-server/src/auth/password';
import { adminAuth, type Hq } from '../helpers';

// A branch as a customer first installs it: no catalog of its own (only the starting units), one admin and one cashier. This is the only kind
// of branch that may connect to HQ (docs/12 §17), and the connect check is ON here.
export type FreshBranch = {
  app: Awaited<ReturnType<typeof buildApp>>;
  http: ReturnType<typeof request>;
  admin: string;
  cashier: string;
  databasePath: string;
  /** Add the branch at HQ and connect it with the one-time code. Resolves to the connect answer. */
  connect: (hq: Hq, code: string) => Promise<request.Response>;
  close: () => Promise<void>;
};

export const PASSWORD = 'correct-horse-battery';
export const api = '/api/v1';
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function startFreshBranch(): Promise<FreshBranch> {
  const dir = mkdtempSync(join(tmpdir(), 'pos-fresh-'));
  const databasePath = join(dir, 'pos.db');
  migrate(databasePath);
  seedReference(databasePath);
  const hash = await hashPassword(PASSWORD);
  const raw = openDatabase(databasePath);
  raw.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('boss', 'boss', 'admin', ?)`).run(hash);
  raw.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('till1', 'till1', 'cashier', ?)`).run(hash);
  raw.close();
  const app = await buildApp({ databasePath, reports: { worker: false }, sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const http = request(app.server);
  const login = async (username: string) =>
    (await http.post(`${api}/auth/login`).send({ username, password: PASSWORD })).body.accessToken as string;
  const admin = await login('boss');
  const cashier = await login('till1');
  return {
    app,
    http,
    admin,
    cashier,
    databasePath,
    async connect(hq, code) {
      const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
      return http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol });
    },
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const until = async (check: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
};
