import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { useSession } from '../../store/session';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';

// Clock in and out (docs/16, P6a-1). An employee types their code and attendance PIN on the till (or the manager's browser, which is signed in); the
// server decides whether it is an in or an out. The PIN does nothing else. A manager also sees who is in now.

type Today = { employeeId: number; code: string; name: string; active: boolean; state: 'in' | 'out' | 'none'; lastAt: string | null };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function AttendancePage() {
  const t = useT();
  const queryClient = useQueryClient();
  const isManager = useSession((s) => s.user?.role === 'manager' || s.user?.role === 'admin');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const today = useQuery({
    queryKey: ['attendance-today'],
    enabled: isManager,
    queryFn: () => get<{ data: Today[] }>('/attendance/today').then((r) => r.data),
    refetchInterval: 30_000,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ employee: { name: string }; kind: 'in' | 'out'; at: string }>('/attendance/punch', { code: code.trim(), pin });
      toast.success(
        r.kind === 'in'
          ? t('{name} is in at {time}', { name: r.employee.name, time: clock(r.at) })
          : t('{name} is out at {time}', { name: r.employee.name, time: clock(r.at) }),
      );
      setCode('');
      setPin('');
      await queryClient.invalidateQueries({ queryKey: ['attendance-today'] });
    } catch (err) {
      setPin('');
      setError(err instanceof ApiError ? err.message : t('That could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  const rows = today.data ?? [];
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <h1>{t('Attendance')}</h1>
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          {t('Type your code and your attendance PIN. The first press clocks you in, the next clocks you out.')}
        </p>
        <label className="field">
          {t('Employee code')}
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoFocus />
        </label>
        <label className="field">
          {t('Attendance PIN')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
        </label>
        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="submit" className="btn primary big" disabled={busy || code.trim() === '' || pin.length < 4}>
            {t('Clock')}
          </button>
        </div>
      </form>

      {isManager && (
        <section className="card">
          <h2>{t('Who is in')}</h2>
          {rows.length === 0 ? (
            <p className="muted">{t('No employees are set up for this branch. Employees are managed at HQ.')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('Employee')}</th>
                  <th>{t('Status')}</th>
                  <th className="num">{t('Since')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employeeId} data-testid="attendance-row">
                    <td>{r.name}</td>
                    <td>{r.state === 'in' ? t('In') : r.state === 'out' ? t('Out') : t('Not yet today')}</td>
                    <td className="num">{r.lastAt ? clock(r.lastAt) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
