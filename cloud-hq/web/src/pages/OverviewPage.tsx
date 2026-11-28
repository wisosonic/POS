import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { ago, lbp, problemText } from '../lib/format';

type Health = {
  status: 'ok' | 'attention';
  backup: { configured: boolean; encrypted: boolean; hasSecondCopy: boolean; lastBackupAt: string | null; problem: string | null };
  branches: {
    id: number;
    code: string;
    name: string;
    kind: 'sale' | 'stock';
    connected: boolean;
    lastSeenAt: string | null;
    pendingChanges: number;
    problems: string[];
  }[];
};
type Totals = { count: number; grossLbp: number; returnsCount: number; returnedLbp: number; netLbp: number; profitLbp: number };
type Overview = {
  from: string;
  branches: ({ branchId: number; code: string; name: string; kind: string; active: boolean; openRegisters: number } & Totals)[];
  totals: Totals;
};

/** The owner's morning page: is everything fine, and what did the chain sell today (what the branches have sent so far). */
export function OverviewPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => get<Health>('/monitoring/branches'), refetchInterval: 60_000 });
  const today = useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/reports/overview'), refetchInterval: 60_000 });

  const h = health.data;
  const t = today.data;
  const problems = (h?.branches ?? []).filter((b) => b.problems.length > 0);
  const figures = new Map((t?.branches ?? []).map((b) => [b.branchId, b]));

  return (
    <div className="stack">
      <h1>The chain today</h1>

      {health.isError && (
        <div className="banner warn" role="alert">
          The chain&rsquo;s health could not be read.
        </div>
      )}
      {h && (
        <section className={`status ${h.status}`} aria-label="Health" data-testid="health">
          <strong>{h.status === 'ok' ? 'Everything is fine.' : 'Something needs a look.'}</strong>
          {h.status !== 'ok' && (
            <ul>
              {problems.map((b) => (
                <li key={b.id}>
                  <strong>{b.name}</strong>: {b.problems.map(problemText).join(' ')}
                </li>
              ))}
              {h.backup.problem && (
                <li>
                  <strong>Backup</strong>: {problemText(h.backup.problem)}
                </li>
              )}
            </ul>
          )}
        </section>
      )}

      {t && (
        <div className="tiles">
          <div className="tile">
            <span className="muted">Sales</span>
            <strong>{t.totals.count.toLocaleString('en-US')}</strong>
          </div>
          <div className="tile">
            <span className="muted">Net sales</span>
            <strong>{lbp(t.totals.netLbp)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Returns</span>
            <strong>{lbp(t.totals.returnedLbp)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Profit</span>
            <strong>{lbp(t.totals.profitLbp)}</strong>
          </div>
        </div>
      )}

      <section className="card">
        <h2>Branches</h2>
        {health.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : (h?.branches.length ?? 0) === 0 ? (
          <p className="muted">No branches yet. Add one under Branches.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>State</th>
                  <th>Last heard</th>
                  <th className="num">Sales today</th>
                  <th className="num">Net today</th>
                  <th className="num">Open tills</th>
                </tr>
              </thead>
              <tbody>
                {h!.branches.map((b) => {
                  const f = figures.get(b.id);
                  return (
                    <tr key={b.id} data-testid="branch-row">
                      <td>
                        <strong>{b.name}</strong> <span className="muted">{b.code}</span>
                        <div className="muted small">{b.kind === 'stock' ? 'Stock branch (warehouse)' : 'Shop'}</div>
                      </td>
                      <td>
                        {b.problems.length === 0 ? (
                          <span className="pill ok">Fine</span>
                        ) : (
                          b.problems.map((p) => (
                            <span key={p} className="pill bad" title={problemText(p)}>
                              {p.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          ))
                        )}
                      </td>
                      <td>{b.connected ? ago(b.lastSeenAt) : '—'}</td>
                      <td className="num">{b.kind === 'stock' ? '—' : (f?.count ?? 0).toLocaleString('en-US')}</td>
                      <td className="num">{b.kind === 'stock' ? '—' : lbp(f?.netLbp ?? 0)}</td>
                      <td className="num">{b.kind === 'stock' ? '—' : (f?.openRegisters ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Figures are what each branch has sent so far today, in Beirut time. A branch that is not heard from may be behind.
        </p>
      </section>

      {h && (
        <section className="card">
          <h2>Backup</h2>
          <p>
            {h.backup.configured ? (
              <>
                Last backup <strong>{ago(h.backup.lastBackupAt)}</strong>
                {h.backup.encrypted ? ', encrypted' : ', not encrypted'}
                {h.backup.hasSecondCopy ? ', with a second copy.' : ', with no second copy.'}
              </>
            ) : (
              'HQ is not making backups.'
            )}
          </p>
        </section>
      )}
    </div>
  );
}
