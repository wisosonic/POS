import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { buildCentral } from '../src/app';
import { migrateCentral } from '../src/db/migrate';

/** The interim HQ admin credential used by the tests. */
export const ADMIN_TOKEN = 'test-hq-admin-token-0123456789abcdef';
export const adminAuth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
export const branchAuth = (token: string) => ({ 'X-Branch-Token': token });

export type Hq = {
  app: FastifyInstance;
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  databasePath: string;
  http: ReturnType<typeof request>;
  /** Stop listening and close the database (the data stays, so `startHq({ databasePath, port })` brings the same HQ back). */
  stop: () => Promise<void>;
  /** Stop and delete everything. */
  close: () => Promise<void>;
};

/**
 * A real HQ server on a free port with its own throwaway database file, for a test. Pass `databasePath` and `port` of a stopped one
 * to bring the same HQ back (an outage and a recovery).
 */
export async function startHq(
  options: {
    databasePath?: string;
    port?: number;
    rateLimit?: boolean;
    allowedHosts?: string[];
    backup?: { dir?: string; copyDir?: string; passphrase?: string; keep?: number };
    webDist?: string;
  } = {},
): Promise<Hq> {
  const dir = options.databasePath ? undefined : mkdtempSync(join(tmpdir(), 'pos-hq-'));
  const databasePath = options.databasePath ?? join(dir!, 'hq.db');
  migrateCentral(databasePath);
  const app = await buildCentral({
    databasePath,
    adminToken: ADMIN_TOKEN,
    rateLimit: options.rateLimit,
    allowedHosts: options.allowedHosts,
    webDist: options.webDist,
    backup: options.backup ? { at: '02:00', keep: 30, schedule: false, ...options.backup } : undefined,
  });
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.close();
  };
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    port,
    databasePath,
    http: request(app.server),
    stop,
    async close() {
      await stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
