import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, patch, post } from '../lib/api';
import { ago, ROLES } from '../lib/format';
import type { Me } from '../lib/session';

type User = {
  id: number;
  username: string;
  name: string;
  role: string;
  active: boolean;
  mustResetPassword: boolean;
  lastLoginAt: string | null;
};

/** HQ's own accounts. A new account gets a password the admin chooses; the person must replace it at first sign-in. */
export function StaffPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['staff'], queryFn: () => get<{ data: User[] }>('/users').then((r) => r.data) });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const [password, setPassword] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['staff'] });
  const fail = (e: unknown) => {
    setNotice('');
    setError(e instanceof ApiError ? e.message : 'That could not be done.');
  };

  const create = useMutation({
    mutationFn: () => post('/users', { username: username.trim(), name: name.trim(), role, password }),
    onSuccess: async () => {
      setNotice(`Account made for ${name.trim()}. Give them the temporary password; they choose their own when they sign in.`);
      setError('');
      setUsername('');
      setName('');
      setPassword('');
      await refresh();
    },
    onError: fail,
  });
  const setActive = useMutation({
    mutationFn: (u: User) => patch(`/users/${u.id}`, { active: !u.active }),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const changeRole = useMutation({
    mutationFn: ({ u, to }: { u: User; to: string }) => patch(`/users/${u.id}`, { role: to }),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: ({ u, pw }: { u: User; pw: string }) => post(`/users/${u.id}/password`, { password: pw }),
    onSuccess: (_r, v) => {
      setError('');
      setNotice(`New temporary password set for ${v.u.name}. They must choose their own at next sign-in.`);
      return refresh();
    },
    onError: fail,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }
  function askReset(u: User) {
    const pw = window.prompt(`A temporary password for ${u.name} (at least 12 characters). They must choose their own after it.`);
    if (pw) reset.mutate({ u, pw });
  }

  return (
    <div className="stack">
      <h1>Staff</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      <section className="card">
        {list.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list.data ?? [])
                  .filter((u) => u.role !== 'employee')
                  .map((u) => (
                    <tr key={u.id} className={u.active ? '' : 'off'} data-testid="staff-row">
                      <td>
                        <strong>{u.name}</strong> <span className="muted">{u.username}</span>
                        {u.mustResetPassword && <span className="pill"> temporary password</span>}
                        {!u.active && <span className="pill bad"> closed</span>}
                      </td>
                      <td>
                        <select
                          value={u.role}
                          onChange={(e) => changeRole.mutate({ u, to: e.target.value })}
                          disabled={u.username === me.username}
                          aria-label={`Role of ${u.name}`}
                        >
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{ago(u.lastLoginAt)}</td>
                      <td className="actions">
                        <button className="btn" onClick={() => askReset(u)}>
                          New password
                        </button>
                        {u.username !== me.username && (
                          <button className="btn ghost" onClick={() => setActive.mutate(u)}>
                            {u.active ? 'Close account' : 'Reopen'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card" onSubmit={submit}>
        <h2>Add a person</h2>
        <div className="row">
          <label className="field">
            Name to sign in with
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="field grow">
            Full name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">{ROLES.find((r) => r.value === role)?.note}.</p>
        <label className="field">
          Temporary password (at least 12 characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <button
          className="btn primary"
          type="submit"
          disabled={create.isPending || username.trim() === '' || name.trim() === '' || password.length < 12}
        >
          Add
        </button>
      </form>
    </div>
  );
}
