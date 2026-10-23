import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../../lib/api';
import type { Role } from '../../lib/types';
import { useSession } from '../../store/session';
import { UserDialog } from './UserDialog';
import { Icon } from '../../components/Icon';

export type UserRow = {
  id: number;
  username: string;
  name: string;
  role: Role;
  active: boolean;
  mustResetPassword: boolean;
  hasPin: boolean;
  phone: string | null;
  email: string | null;
};

const ROLE: Record<Role, string> = { cashier: 'Cashier', manager: 'Manager', admin: 'Admin' };

/** Who can sign in, and as what. The admin adds people, gives a first password or PIN, changes roles, and switches people off. */
export function UsersPage() {
  const queryClient = useQueryClient();
  const me = useSession((s) => s.user);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<{ data: UserRow[] }>('/users').then((r) => r.data) });
  const rows = users.data ?? [];

  return (
    <main className="page">
      <h1>
        <Icon name="users" size={26} />
        Users
      </h1>
      <div className="toolbar">
        <p className="muted" style={{ margin: 0 }}>
          Cashiers can also have a PIN for switching at the till. Managers and admins always use their password.
        </p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          New user
        </button>
      </div>

      {users.isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>PIN</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} data-testid="user-row" style={u.active ? undefined : { opacity: 0.6 }}>
                <td>{u.username}</td>
                <td>{u.name}</td>
                <td>{ROLE[u.role]}</td>
                <td>
                  {!u.active ? 'Switched off' : u.mustResetPassword ? 'Must choose a password' : 'Active'}
                  {u.id === me?.id && <span className="muted"> (you)</span>}
                </td>
                <td>{u.role === 'cashier' ? (u.hasPin ? 'Yes' : 'No') : ''}</td>
                <td className="num">
                  <button className="btn small" onClick={() => setEditing(u)} aria-label={`Edit ${u.username}`}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          isMe={editing !== 'new' && editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['users'] })}
        />
      )}
    </main>
  );
}
