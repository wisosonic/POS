import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { clock, hm, money } from '../lib/format';

type Slip = { id: number; fromDay: string; toDay: string; currency: string; netMinor: number };
type Day = { day: string; minutes: number; punches: { at: string; kind: 'in' | 'out' }[]; flags: string[] };

/** What an employee account sees: only their own attendance and their own PAID payslips. Everything here is read through /me, so another person's is never reachable. */
export function MyPayPage({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const slips = useQuery({ queryKey: ['my-slips'], queryFn: () => get<{ data: Slip[] }>('/me/payslips').then((r) => r.data) });
  const days = useQuery({ queryKey: ['my-days'], queryFn: () => get<{ data: Day[] }>('/me/attendance').then((r) => r.data) });
  const [error, setError] = useState('');
  const print = useMutation({
    mutationFn: (id: number) => post<{ url: string }>(`/me/payslips/${id}/print-link`, { lang: 'en' }),
    onSuccess: (r) => window.open(r.url, '_blank', 'noopener'),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That could not be done.'),
  });
  // An account that is not linked to an employee gets a plain answer, not a broken page.
  const unlinked = [slips.error, days.error].some((e) => e instanceof ApiError && e.code === 'NOT_AN_EMPLOYEE');

  return (
    <main className="page narrow-page">
      <div className="stack">
        <h1>Hello, {name}</h1>
        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}
        {unlinked ? (
          <div className="banner warn">This account is not linked to an employee yet. Ask HR.</div>
        ) : (
          <>
            <section className="card">
              <h2>My payslips</h2>
              {(slips.data ?? []).length === 0 ? (
                <p className="muted">No payslip yet. A payslip appears here once the month&rsquo;s payroll has been paid.</p>
              ) : (
                <ul className="plain">
                  {(slips.data ?? []).map((s) => (
                    <li key={s.id} data-testid="my-slip">
                      {s.fromDay} to {s.toDay}: <strong>{money(s.netMinor, s.currency)}</strong>{' '}
                      <button className="btn" onClick={() => print.mutate(s.id)} disabled={print.isPending}>
                        Open to print
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card">
              <h2>My attendance, last two weeks</h2>
              {(days.data ?? []).length === 0 ? (
                <p className="muted">Nothing recorded.</p>
              ) : (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th>Punches</th>
                        <th className="num">Worked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(days.data ?? []).map((d) => (
                        <tr key={d.day}>
                          <td>{d.day}</td>
                          <td>
                            {d.punches.map((p) => `${p.kind} ${clock(p.at)}`).join(' · ')}
                            {d.flags.length > 0 && <span className="pill bad"> ask HR to check</span>}
                          </td>
                          <td className="num">{hm(d.minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
        <p>
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </div>
    </main>
  );
}
