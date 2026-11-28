import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../lib/api';
import { clock, flagText, hm } from '../lib/format';
import { canHr, type Me } from '../lib/session';
import { useBranches, useEmployees } from './PeoplePage';

type Punch = { at: string; kind: 'in' | 'out'; branchId: number; source: 'punch' | 'adjustment'; id: number };
type Day = { employeeId: number; code: string; name: string; day: string; minutes: number; punches: Punch[]; flags: string[] };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

/** Who worked when. A punch a branch recorded is never edited: a mistake is fixed by adding a punch or cancelling one, with a reason that is kept. */
export function AttendancePage({ me }: { me: Me }) {
  const hr = canHr(me);
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const branches = useBranches();
  const [from, setFrom] = useState(daysAgo(13));
  const [to, setTo] = useState(isoDay(new Date()));
  const [branchId, setBranchId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const q = new URLSearchParams({ from, to });
  if (branchId) q.set('branchId', branchId);
  if (employeeId) q.set('employeeId', employeeId);
  const days = useQuery({
    queryKey: ['attendance', from, to, branchId, employeeId],
    queryFn: () => get<{ data: Day[] }>(`/attendance/days?${q.toString()}`).then((r) => r.data),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['attendance'] });
  const fail = (e: unknown) => {
    setNotice('');
    setError(e instanceof ApiError ? e.message : 'That could not be done.');
  };
  const branchName = (id: number) => (branches.data ?? []).find((b) => b.id === id)?.name ?? `Branch ${id}`;

  const [addEmp, setAddEmp] = useState('');
  const [addBranch, setAddBranch] = useState('');
  const [addKind, setAddKind] = useState<'in' | 'out'>('in');
  const [addAt, setAddAt] = useState('');
  const [addReason, setAddReason] = useState('');
  const add = useMutation({
    mutationFn: () =>
      post('/attendance/adjustments', {
        action: 'add',
        employeeId: Number(addEmp),
        branchId: Number(addBranch),
        kind: addKind,
        at: new Date(addAt).toISOString(),
        reason: addReason.trim(),
      }),
    onSuccess: async () => {
      setError('');
      setNotice('The punch is added, with your reason.');
      setAddReason('');
      await refresh();
    },
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: ({ d, p, reason }: { d: Day; p: Punch; reason: string }) =>
      post('/attendance/adjustments', { action: 'cancel', employeeId: d.employeeId, branchId: p.branchId, punchId: p.id, reason }),
    onSuccess: async () => {
      setError('');
      setNotice('The punch is cancelled. It stays on record with your reason.');
      await refresh();
    },
    onError: fail,
  });

  function askCancel(d: Day, p: Punch) {
    const reason = window.prompt(`Why cancel ${d.name}'s clock-${p.kind} at ${clock(p.at)}? (at least 3 characters; it is kept)`);
    if (reason && reason.trim().length >= 3) cancel.mutate({ d, p, reason: reason.trim() });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (Number.isNaN(new Date(addAt).getTime())) return setError('Choose the date and time of the punch.');
    add.mutate();
  }

  const rows = days.data ?? [];
  const problems = rows.filter((d) => d.flags.length > 0).length;

  return (
    <div className="stack">
      <h1>Attendance</h1>
      <section className="card">
        <div className="row">
          <label className="field">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field">
            Branch
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Person
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Everyone</option>
              {(employees.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      {problems > 0 && (
        <div className="banner warn">
          {problems} day{problems === 1 ? '' : 's'} need a look: a missing clock-in or clock-out adds no time until it is corrected.
        </div>
      )}

      <section className="card">
        {days.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : rows.length === 0 ? (
          <p className="muted">No punches in this period.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Person</th>
                  <th>Punches</th>
                  <th className="num">Worked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={`${d.employeeId}|${d.day}`} data-testid="attendance-row">
                    <td>{d.day}</td>
                    <td>
                      <strong>{d.name}</strong> <span className="muted">{d.code}</span>
                    </td>
                    <td>
                      <ul className="plain">
                        {d.punches.map((p) => (
                          <li key={`${p.source}${p.id}`}>
                            <span className={`pill ${p.kind === 'in' ? 'ok' : ''}`}>{p.kind}</span> {clock(p.at)}{' '}
                            <span className="muted small">
                              {branchName(p.branchId)}
                              {p.source === 'adjustment' ? ' · added by HR' : ''}
                            </span>
                            {hr && p.source === 'punch' && (
                              <button
                                className="link"
                                onClick={() => askCancel(d, p)}
                                aria-label={`Cancel the ${p.kind} at ${clock(p.at)}`}
                              >
                                cancel
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {d.flags.map((f) => (
                        <span key={f} className="pill bad">
                          {flagText(f)}
                        </span>
                      ))}
                    </td>
                    <td className="num">{hm(d.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hr && (
        <form className="card" onSubmit={submit}>
          <h2>Add a missed punch</h2>
          <div className="row">
            <label className="field">
              Person
              <select value={addEmp} onChange={(e) => setAddEmp(e.target.value)} required>
                <option value="">Choose&hellip;</option>
                {(employees.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Branch
              <select value={addBranch} onChange={(e) => setAddBranch(e.target.value)} required>
                <option value="">Choose&hellip;</option>
                {(branches.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Clock
              <select value={addKind} onChange={(e) => setAddKind(e.target.value === 'out' ? 'out' : 'in')}>
                <option value="in">in</option>
                <option value="out">out</option>
              </select>
            </label>
            <label className="field">
              When
              <input type="datetime-local" value={addAt} onChange={(e) => setAddAt(e.target.value)} required />
            </label>
          </div>
          <label className="field">
            Reason (kept on record)
            <input value={addReason} onChange={(e) => setAddReason(e.target.value)} autoComplete="off" />
          </label>
          <button
            className="btn primary"
            type="submit"
            disabled={add.isPending || addEmp === '' || addBranch === '' || addReason.trim().length < 3}
          >
            Add the punch
          </button>
        </form>
      )}
    </div>
  );
}
