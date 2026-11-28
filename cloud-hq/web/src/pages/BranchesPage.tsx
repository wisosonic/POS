import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, patch, post } from '../lib/api';
import { ago } from '../lib/format';
import { isAdmin, type Me } from '../lib/session';

type Branch = {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'stock';
  active: boolean;
  connected: boolean;
  enrolPending: boolean;
  lastSeenAt: string | null;
};
type Issued = { branchName: string; code: string; expiresAt: string };

/** The one-time code lives only in this component's state: it is shown once and gone when the page is left, as HQ keeps only its hash. */
export function BranchesPage({ me }: { me: Me }) {
  const admin = isAdmin(me);
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['branches'], queryFn: () => get<{ data: Branch[] }>('/branches').then((r) => r.data) });
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'sale' | 'stock'>('sale');
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['branches'] }), queryClient.invalidateQueries({ queryKey: ['health'] })]);

  const create = useMutation({
    mutationFn: () =>
      post<{ branch: { name: string }; enrolCode: string; expiresAt: string }>('/branches', { code: code.trim(), name: name.trim(), kind }),
    onSuccess: async (r) => {
      setIssued({ branchName: r.branch.name, code: r.enrolCode, expiresAt: r.expiresAt });
      setCode('');
      setName('');
      setError('');
      await refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The branch could not be added.'),
  });
  const newCode = useMutation({
    mutationFn: (b: Branch) => post<{ enrolCode: string; expiresAt: string }>(`/branches/${b.id}/enrol-code`).then((r) => ({ b, r })),
    onSuccess: async ({ b, r }) => {
      setIssued({ branchName: b.name, code: r.enrolCode, expiresAt: r.expiresAt });
      setError('');
      await refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'A new code could not be made.'),
  });
  const toggle = useMutation({
    mutationFn: (b: Branch) => patch(`/branches/${b.id}`, { active: !b.active }),
    onSuccess: () => refresh(),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The branch could not be changed.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <div className="stack">
      <h1>Branches</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}

      {issued && (
        <section className="card highlight" data-testid="enrol-code">
          <h2>One-time code for {issued.branchName}</h2>
          <p className="code">{issued.code}</p>
          <p>
            Type it at the branch (Settings &rarr; Branch server) together with HQ&rsquo;s address. It works once, until{' '}
            {new Date(issued.expiresAt).toLocaleString()}. HQ keeps only a scrambled copy, so write it down now: it cannot be shown again.
          </p>
          <button className="btn" onClick={() => setIssued(null)}>
            I have it
          </button>
        </section>
      )}

      <section className="card">
        {list.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Last heard</th>
                  {admin && <th />}
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((b) => (
                  <tr key={b.id} data-testid="branch-row">
                    <td>
                      <strong>{b.name}</strong> <span className="muted">{b.code}</span>
                    </td>
                    <td>{b.kind === 'stock' ? 'Stock (warehouse)' : 'Shop'}</td>
                    <td>
                      {!b.active ? (
                        <span className="pill bad">closed</span>
                      ) : b.connected ? (
                        <span className="pill ok">connected</span>
                      ) : b.enrolPending ? (
                        <span className="pill">waiting for its code</span>
                      ) : (
                        <span className="pill bad">not connected</span>
                      )}
                    </td>
                    <td>{b.connected ? ago(b.lastSeenAt) : '—'}</td>
                    {admin && (
                      <td className="actions">
                        {!b.connected && b.active && (
                          <button className="btn" onClick={() => newCode.mutate(b)} disabled={newCode.isPending}>
                            New code
                          </button>
                        )}
                        <button className="btn ghost" onClick={() => toggle.mutate(b)} disabled={toggle.isPending}>
                          {b.active ? 'Close' : 'Reopen'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {(list.data ?? []).length === 0 && <p className="muted">No branches yet.</p>}
          </div>
        )}
      </section>

      {admin ? (
        <form className="card" onSubmit={submit}>
          <h2>Add a branch</h2>
          <div className="row">
            <label className="field">
              Short code (1 to 8 letters or digits)
              <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} />
            </label>
            <label className="field grow">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </label>
            <label className="field">
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as 'sale' | 'stock')}>
                <option value="sale">Shop (has tills)</option>
                <option value="stock">Stock (warehouse, no tills)</option>
              </select>
            </label>
          </div>
          <p className="muted small">The kind cannot be changed once the branch has connected.</p>
          <button className="btn primary" type="submit" disabled={create.isPending || code.trim() === '' || name.trim() === ''}>
            Add and make its code
          </button>
        </form>
      ) : (
        <p className="muted">Only an admin adds or closes branches.</p>
      )}
    </div>
  );
}
