import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, patch, post, api } from '../lib/api';
import { canHr, type Me } from '../lib/session';

export type Employee = { id: number; code: string; name: string; active: boolean; hasPin: boolean; branchIds: number[] };
type Branch = { id: number; code: string; name: string; kind: 'sale' | 'stock'; active: boolean };

/** Hooks shared with the other HR pages: the employees and the branches. */
export const useEmployees = () =>
  useQuery({ queryKey: ['employees'], queryFn: () => get<{ data: Employee[] }>('/employees?limit=500').then((r) => r.data) });
export const useBranches = () =>
  useQuery({ queryKey: ['branches'], queryFn: () => get<{ data: Branch[] }>('/branches').then((r) => r.data) });

/** The people who work in the chain. An employee is not always a user: a cleaner has no sign-in. HR changes them; the attendance PIN can only clock in and out. */
export function PeoplePage({ me }: { me: Me }) {
  const hr = canHr(me);
  const queryClient = useQueryClient();
  const list = useEmployees();
  const branches = useBranches();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employees'] });
  const fail = (e: unknown) => {
    setNotice('');
    setError(e instanceof ApiError ? e.message : 'That could not be done.');
  };
  const done = (msg: string) => {
    setError('');
    setNotice(msg);
    return refresh();
  };
  const branchName = (id: number) => (branches.data ?? []).find((b) => b.id === id)?.name ?? `Branch ${id}`;

  const create = useMutation({
    mutationFn: () => post('/employees', { code: code.trim(), name: name.trim(), branchIds: picked }),
    onSuccess: async () => {
      await done(`${name.trim()} added.`);
      setCode('');
      setName('');
      setPicked([]);
    },
    onError: fail,
  });
  const setActive = useMutation({
    mutationFn: (e: Employee) => patch(`/employees/${e.id}`, { active: !e.active }),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const setBranches = useMutation({
    mutationFn: ({ e, ids }: { e: Employee; ids: number[] }) => api('PUT', `/employees/${e.id}/branches`, { branchIds: ids }),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const setPin = useMutation({
    mutationFn: ({ e, pin }: { e: Employee; pin: string }) => post(`/employees/${e.id}/pin`, { pin }),
    onSuccess: (_r, v) => done(`A new attendance PIN is set for ${v.e.name}. Tell them privately; it is not shown again.`),
    onError: fail,
  });
  const makeAccount = useMutation({
    mutationFn: ({ e, username, password }: { e: Employee; username: string; password: string }) =>
      post(`/employees/${e.id}/account`, { username, password }),
    onSuccess: (_r, v) =>
      done(`A sign-in is made for ${v.e.name}. Give them the temporary password; they choose their own at first sign-in.`),
    onError: fail,
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    create.mutate();
  }
  const toggle = (id: number, ids: number[]) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  function askPin(e: Employee) {
    const pin = window.prompt(`An attendance PIN for ${e.name}: 4 to 8 digits. It can only clock in and out.`);
    if (pin) setPin.mutate({ e, pin: pin.trim() });
  }
  function askAccount(e: Employee) {
    const username = window.prompt(`A name for ${e.name} to sign in with (letters, digits, dot, dash, underscore).`);
    if (!username) return;
    const password = window.prompt('A temporary password (at least 12 characters). They must choose their own after it.');
    if (password) makeAccount.mutate({ e, username: username.trim(), password });
  }

  const rows = (list.data ?? []).filter((e) => showClosed || e.active);
  const shops = (branches.data ?? []).filter((b) => b.active);

  return (
    <div className="stack">
      <h1>People</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      <section className="card">
        <label className="check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show people who have left
        </label>
        {list.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : rows.length === 0 ? (
          <p className="muted">Nobody yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Works at</th>
                  <th>PIN</th>
                  {hr && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={e.active ? '' : 'off'} data-testid="employee-row">
                    <td>
                      <code>{e.code}</code>
                    </td>
                    <td>
                      <strong>{e.name}</strong>
                      {!e.active && <span className="pill bad"> left</span>}
                    </td>
                    <td>
                      {hr ? (
                        <div className="checks">
                          {shops.map((b) => (
                            <label key={b.id} className="check">
                              <input
                                type="checkbox"
                                checked={e.branchIds.includes(b.id)}
                                onChange={() => setBranches.mutate({ e, ids: toggle(b.id, e.branchIds) })}
                              />{' '}
                              {b.name}
                            </label>
                          ))}
                        </div>
                      ) : (
                        e.branchIds.map(branchName).join(', ') || <span className="muted">nowhere yet</span>
                      )}
                    </td>
                    <td>{e.hasPin ? <span className="pill ok">set</span> : <span className="pill">none</span>}</td>
                    {hr && (
                      <td className="actions">
                        <button className="btn" onClick={() => askPin(e)}>
                          {e.hasPin ? 'New PIN' : 'Set PIN'}
                        </button>
                        <button className="btn" onClick={() => askAccount(e)}>
                          Give a sign-in
                        </button>
                        <button className="btn ghost" onClick={() => setActive.mutate(e)}>
                          {e.active ? 'Left the company' : 'Back at work'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hr && (
        <form className="card" onSubmit={submit}>
          <h2>Add a person</h2>
          <div className="row">
            <label className="field">
              Code (on their badge)
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
            </label>
            <label className="field grow">
              Full name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <fieldset className="checks">
            <legend className="muted small">Works at</legend>
            {shops.map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" checked={picked.includes(b.id)} onChange={() => setPicked(toggle(b.id, picked))} /> {b.name}
              </label>
            ))}
          </fieldset>
          <button className="btn primary" type="submit" disabled={create.isPending || code.trim() === '' || name.trim() === ''}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
