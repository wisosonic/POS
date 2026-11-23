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

/** Connect (or connect again, replacing the old link). The local branch takes HQ's code and name, which receipts will print. */
export async function saveLink(q: Queryable, actorId: number, hqUrl: string, token: string, branch: HqBranch): Promise<void> {
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
  await writeAuditQ(q, {
    userId: actorId,
    action: 'hq.connect',
    entity: 'hq',
    after: { hqUrl, branchCode: branch.code, branchName: branch.name },
  });
}

export async function clearLink(q: Queryable, actorId: number): Promise<boolean> {
  const r = await q.run('DELETE FROM hq_link WHERE id = 1');
  if (r.changes > 0) await writeAuditQ(q, { userId: actorId, action: 'hq.disconnect', entity: 'hq' });
  return r.changes > 0;
}

export async function recordOk(q: Queryable): Promise<void> {
  await q.run('UPDATE hq_link SET last_ok_at = ?, last_error = NULL WHERE id = 1', [nowIso()]);
}

export async function recordError(q: Queryable, error: string): Promise<void> {
  await q.run('UPDATE hq_link SET last_error = ? WHERE id = 1', [error.slice(0, 300)]);
}
