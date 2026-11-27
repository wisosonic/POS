import { SYNC_TABLES } from '@pos/core/sync';
import { AppError } from '@pos/core/errors';
import type { Queryable } from '../../db/adapter';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import type { HqBranch } from './hqClient';

// The branch's link to HQ (migration 0017). The token never leaves this module except to the HQ client, which sends it to HQ.

export type Link = {
  hqUrl: string;
  token: string;
  branch: HqBranch;
  connectedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
};

type LinkRow = {
  hq_url: string;
  branch_token: string;
  hq_branch_id: number;
  hq_branch_code: string;
  hq_branch_name: string;
  connected_at: string;
  last_ok_at: string | null;
  last_error: string | null;
};

export async function getLink(q: Queryable): Promise<Link | null> {
  const r = await q.one<LinkRow>('SELECT * FROM hq_link WHERE id = 1');
  return r
    ? {
        hqUrl: r.hq_url,
        token: r.branch_token,
        branch: { id: r.hq_branch_id, code: r.hq_branch_code, name: r.hq_branch_name },
        connectedAt: r.connected_at,
        lastOkAt: r.last_ok_at,
        lastError: r.last_error,
      }
    : null;
}

/**
 * The catalog's lists come from HQ with HQ's ids (P3a), so a branch may connect only while it has no catalog of its own: no products,
 * categories, brands or suppliers, and no unit besides the three it starts with. Exception: a branch whose catalog already came from THIS
 * HQ (it connects again with a new code). Call it BEFORE the one-time code is spent, so a refusal does not waste the code.
 */
export async function assertCatalogCanConnect(q: Queryable, hqUrl: string): Promise<void> {
  const from = await q.one<{ catalog_hq_url: string | null }>('SELECT catalog_hq_url FROM sync_control WHERE id = 1');
  if (from?.catalog_hq_url === hqUrl) return;
  const count = async (sql: string) => (await q.one<{ n: number }>(sql))!.n;
  const own =
    (await count('SELECT COUNT(*) AS n FROM products')) +
    (await count('SELECT COUNT(*) AS n FROM categories')) +
    (await count('SELECT COUNT(*) AS n FROM brands')) +
    (await count('SELECT COUNT(*) AS n FROM suppliers')) +
    (await count('SELECT COUNT(*) AS n FROM units WHERE id > 3'));
  if (own > 0)
    throw new AppError(
      409,
      'CATALOG_NOT_EMPTY',
      'This branch already has products, categories, brands or suppliers of its own. A branch takes its catalog from HQ, so connect a branch that has none (a fresh install), and add the products at HQ.',
    );
}

/** Connect (or connect again, replacing the old link). The local branch takes HQ's code and name, which receipts will print. */
export async function saveLink(q: Queryable, actorId: number, hqUrl: string, token: string, branch: HqBranch): Promise<void> {
  await q.run('UPDATE sync_control SET catalog_hq_url = ? WHERE id = 1', [hqUrl]);
  const now = nowIso();
  await q.run(
    `INSERT INTO hq_link (id, hq_url, branch_token, hq_branch_id, hq_branch_code, hq_branch_name, connected_at, last_ok_at, last_error)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET hq_url = excluded.hq_url, branch_token = excluded.branch_token, hq_branch_id = excluded.hq_branch_id,
       hq_branch_code = excluded.hq_branch_code, hq_branch_name = excluded.hq_branch_name, connected_at = excluded.connected_at,
       last_ok_at = excluded.last_ok_at, last_error = NULL`,
    [hqUrl, token, branch.id, branch.code, branch.name, now, now],
  );
  await q.run('UPDATE branches SET code = ?, name = ? WHERE id = 1', [branch.code, branch.name]);
  await startCapture(q);
  await writeAuditQ(q, {
    userId: actorId,
    action: 'hq.connect',
    entity: 'hq',
    after: { hqUrl, branchCode: branch.code, branchName: branch.name },
  });
}

export async function clearLink(q: Queryable, actorId: number): Promise<boolean> {
  const r = await q.run('DELETE FROM hq_link WHERE id = 1');
  if (r.changes > 0) {
    await stopCapture(q);
    await writeAuditQ(q, { userId: actorId, action: 'hq.disconnect', entity: 'hq' });
  }
  return r.changes > 0;
}

/**
 * Start recording changes for HQ, in the SAME transaction as connecting. Every row that exists right now is covered by the snapshot (it sends
 * rows up to the highest id seen here); every row written after this commits is covered by the triggers. So nothing falls in between. Connecting
 * again starts from scratch: the snapshot is sent again (HQ's upserts make that harmless).
 */
async function startCapture(q: Queryable): Promise<void> {
  await q.run('DELETE FROM sync_outbox');
  await q.run('DELETE FROM sync_snapshot');
  for (const t of SYNC_TABLES) await q.run(`INSERT INTO sync_snapshot (tbl, upto) SELECT ?, COALESCE(MAX(id), 0) FROM ${t.name}`, [t.name]);
  await q.run('UPDATE sync_control SET capture = 1, last_push_at = NULL, down_cursor = 0 WHERE id = 1');
}

/**
 * Send everything again: the first send of history is started over for every table. HQ stores rows with upserts, so rows it already has are
 * simply stored again, and a row it lost comes back. This is the way back from a difference the daily control found (docs/12 §24). The outbox,
 * the link and the down cursor are not touched.
 */
export async function restartSnapshot(q: Queryable): Promise<void> {
  await q.run('DELETE FROM sync_snapshot');
  for (const t of SYNC_TABLES) await q.run(`INSERT INTO sync_snapshot (tbl, upto) SELECT ?, COALESCE(MAX(id), 0) FROM ${t.name}`, [t.name]);
}

/** A branch that is not connected records nothing, and keeps nothing waiting. */
async function stopCapture(q: Queryable): Promise<void> {
  await q.run('UPDATE sync_control SET capture = 0, last_push_at = NULL, down_cursor = 0 WHERE id = 1');
  await q.run('DELETE FROM sync_outbox');
  await q.run('DELETE FROM sync_snapshot');
}

export type SyncProgress = {
  capturing: boolean;
  /** Changes recorded and not yet confirmed by HQ. */
  pending: number;
  /** The rows that existed when the branch connected, and still have to be sent. */
  snapshot: { tables: { table: string; sent: number; total: number; done: boolean }[]; done: boolean };
  lastPushAt: string | null;
};

export async function syncProgress(q: Queryable): Promise<SyncProgress> {
  const control = (await q.one<{ capture: number; last_push_at: string | null }>(
    'SELECT capture, last_push_at FROM sync_control WHERE id = 1',
  ))!;
  const pending = (await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))!.n;
  const snaps = await q.all<{ tbl: string; upto: number; next_pk: number; done: number }>(
    'SELECT tbl, upto, next_pk, done FROM sync_snapshot ORDER BY tbl',
  );
  const tables = [];
  for (const s of snaps) {
    // "Total" is the number of rows up to the highest id at connect time; "sent" the rows already sent. (Counted, not guessed from ids.)
    const total = (await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${s.tbl} WHERE id <= ?`, [s.upto]))!.n;
    const sent = s.done ? total : (await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${s.tbl} WHERE id <= ?`, [s.next_pk]))!.n;
    tables.push({ table: s.tbl, sent, total, done: s.done === 1 });
  }
  return {
    capturing: control.capture === 1,
    pending,
    snapshot: { tables, done: tables.every((t) => t.done) },
    lastPushAt: control.last_push_at,
  };
}

export async function recordOk(q: Queryable): Promise<void> {
  await q.run('UPDATE hq_link SET last_ok_at = ?, last_error = NULL WHERE id = 1', [nowIso()]);
}

export async function recordError(q: Queryable, error: string): Promise<void> {
  await q.run('UPDATE hq_link SET last_error = ? WHERE id = 1', [error.slice(0, 300)]);
}
