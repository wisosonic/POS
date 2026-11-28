import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api, get, patch, post } from '../lib/api';
import { addDays, hm, parseTime, scheduleStatusText, shiftText, weekdayName, weekStart } from '../lib/format';
import { canHr, type Me } from '../lib/session';
import { useBranches, useEmployees } from './PeoplePage';

type Shift = { id: number; name: string; startMinute: number; lengthMinutes: number; graceMinutes: number; active: boolean };
type RosterRow = { employeeId: number; employee: string; day: string; shiftId: number; branchId: number };
type Holiday = { day: string; name: string };
type LeaveType = { id: number; code: string; name: string; paid: boolean };
type Leave = {
  id: number;
  employeeId: number;
  employee: string;
  type: string;
  paid: boolean;
  fromDay: string;
  toDay: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reason: string | null;
  decidedBy: string | null;
};
type PlanDay = {
  employeeId: number;
  employee: string;
  day: string;
  status: string;
  shift: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  leave: { type: string; paid: boolean } | null;
  flags: string[];
};
type Plan = {
  data: PlanDay[];
  totals: {
    scheduledMinutes: number;
    workedMinutes: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    absentDays: number;
    leaveDays: number;
  };
};

const TABS = ['Roster', 'Plan and what happened', 'Leave', 'Shifts and holidays'] as const;
type Tab = (typeof TABS)[number];
const today = () => new Date().toISOString().slice(0, 10);
const useShifts = () => useQuery({ queryKey: ['shifts'], queryFn: () => get<{ data: Shift[] }>('/shifts').then((r) => r.data) });
const useHolidays = () => useQuery({ queryKey: ['holidays'], queryFn: () => get<{ data: Holiday[] }>('/holidays').then((r) => r.data) });

type Say = { fail: (e: unknown) => void; ok: (m: string) => void; hr: boolean };

/** Who works when, and what happened against the plan. A roster is a plan, so it can be changed (every change is audited); a punch is never touched here. */
export function SchedulePage({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('Roster');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const say: Say = {
    hr: canHr(me),
    fail: (e) => {
      setNotice('');
      setError(e instanceof ApiError ? e.message : 'That could not be done.');
    },
    ok: (m) => {
      setError('');
      setNotice(m);
    },
  };
  return (
    <div className="stack">
      <h1>Schedule</h1>
      <div className="tabs" role="tablist" aria-label="Schedule">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'tab on' : 'tab'}
            onClick={() => {
              setTab(t);
              setError('');
              setNotice('');
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      {tab === 'Roster' && <RosterTab {...say} />}
      {tab === 'Plan and what happened' && <PlanTab />}
      {tab === 'Leave' && <LeaveTab {...say} />}
      {tab === 'Shifts and holidays' && <ShiftsTab {...say} />}
    </div>
  );
}

function RosterTab({ fail, ok, hr }: Say) {
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const branches = useBranches();
  const shifts = useShifts();
  const holidays = useHolidays();
  const [start, setStart] = useState(weekStart(today()));
  const [branchPick, setBranchPick] = useState('');
  const shops = (branches.data ?? []).filter((b) => b.active && b.kind === 'sale');
  const branchId = Number(branchPick || shops[0]?.id || 0);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6]!;
  const roster = useQuery({
    queryKey: ['roster', start, branchId],
    queryFn: () => get<{ data: RosterRow[] }>(`/roster?from=${start}&to=${end}&branchId=${branchId}`).then((r) => r.data),
    enabled: branchId > 0,
  });
  const people = (employees.data ?? []).filter((e) => e.active && e.branchIds.includes(branchId));
  const active = (shifts.data ?? []).filter((s) => s.active);
  const holiday = new Map((holidays.data ?? []).map((h) => [h.day, h.name]));
  const cell = new Map((roster.data ?? []).map((r) => [`${r.employeeId}|${r.day}`, r.shiftId]));
  const shiftName = (id: number) => (shifts.data ?? []).find((s) => s.id === id)?.name ?? `Shift ${id}`;

  const save = useMutation({
    mutationFn: (entries: { employeeId: number; day: string; shiftId: number | null; branchId: number }[]) =>
      api('PUT', '/roster', { entries }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roster'] }),
    onError: fail,
  });
  const copy = useMutation({
    mutationFn: async () => {
      const prev = await get<{ data: RosterRow[] }>(`/roster?from=${addDays(start, -7)}&to=${addDays(start, -1)}&branchId=${branchId}`);
      const entries = prev.data
        .filter((r) => people.some((p) => p.id === r.employeeId) && active.some((s) => s.id === r.shiftId))
        .map((r) => ({ employeeId: r.employeeId, day: addDays(r.day, 7), shiftId: r.shiftId, branchId }));
      if (entries.length === 0) throw new ApiError(0, 'NOTHING', 'Last week has nothing to copy.');
      await api('PUT', '/roster', { entries });
      return entries.length;
    },
    onSuccess: async (n) => {
      ok(`Copied ${n} shift${n === 1 ? '' : 's'} from last week.`);
      await queryClient.invalidateQueries({ queryKey: ['roster'] });
    },
    onError: fail,
  });

  return (
    <section className="card">
      <div className="row">
        <label className="field">
          Branch
          <select value={branchId || ''} onChange={(e) => setBranchPick(e.target.value)}>
            {shops.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button className="btn" onClick={() => setStart(addDays(start, -7))}>
            &larr; Previous week
          </button>
          <strong>
            {start} to {end}
          </strong>
          <button className="btn" onClick={() => setStart(addDays(start, 7))}>
            Next week &rarr;
          </button>
        </div>
        {hr && (
          <button className="btn" disabled={copy.isPending || branchId === 0} onClick={() => copy.mutate()}>
            Copy last week
          </button>
        )}
      </div>
      {shops.length === 0 ? (
        <p className="muted">There is no shop branch yet.</p>
      ) : people.length === 0 ? (
        <p className="muted">Nobody is assigned to this branch. Assign people on the People page.</p>
      ) : (
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Person</th>
                {days.map((d) => (
                  <th key={d} className={holiday.has(d) ? 'holiday' : ''}>
                    {weekdayName(d)} {d.slice(8)}
                    {holiday.has(d) && <span className="muted small"> {holiday.get(d)}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} data-testid="roster-row">
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  {days.map((d) => {
                    const current = cell.get(`${p.id}|${d}`);
                    return (
                      <td key={d} className={holiday.has(d) ? 'holiday' : ''}>
                        {hr ? (
                          <select
                            aria-label={`${p.name}, ${d}`}
                            value={current ?? ''}
                            disabled={save.isPending}
                            onChange={(e) =>
                              save.mutate([
                                { employeeId: p.id, day: d, shiftId: e.target.value === '' ? null : Number(e.target.value), branchId },
                              ])
                            }
                          >
                            <option value="">off</option>
                            {/* a shift that was retired but is still on the roster stays visible so the cell is not blank */}
                            {current !== undefined && !active.some((s) => s.id === current) && (
                              <option value={current}>{shiftName(current)}</option>
                            )}
                            {active.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        ) : current === undefined ? (
                          <span className="muted">off</span>
                        ) : (
                          shiftName(current)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlanTab() {
  const branches = useBranches();
  const [from, setFrom] = useState(weekStart(today()));
  const [to, setTo] = useState(today());
  const [branchId, setBranchId] = useState('');
  const q = new URLSearchParams({ from, to });
  if (branchId) q.set('branchId', branchId);
  const plan = useQuery({ queryKey: ['plan', from, to, branchId], queryFn: () => get<Plan>(`/attendance/schedule?${q.toString()}`) });
  const rows = plan.data?.data ?? [];
  const t = plan.data?.totals;
  return (
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
      </div>
      {plan.isError && <p className="banner warn">Ask for at most 62 days, with the start before the end.</p>}
      {t && (
        <div className="tiles">
          <div className="tile">
            <span className="muted">Planned</span>
            <strong>{hm(t.scheduledMinutes)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Worked</span>
            <strong>{hm(t.workedMinutes)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Late / left early</span>
            <strong>
              {t.lateMinutes} / {t.earlyLeaveMinutes} min
            </strong>
          </div>
          <div className="tile">
            <span className="muted">Absent days / leave days</span>
            <strong>
              {t.absentDays} / {t.leaveDays}
            </strong>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="muted">{plan.isLoading ? 'Loading…' : 'Nothing planned or recorded in this period.'}</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Person</th>
                <th>Shift</th>
                <th>What happened</th>
                <th className="num">Worked</th>
                <th className="num">Late</th>
                <th className="num">Left early</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.employeeId}|${r.day}`} data-testid="plan-row">
                  <td>
                    {weekdayName(r.day)} {r.day}
                  </td>
                  <td>{r.employee}</td>
                  <td>{r.shift ?? <span className="muted">-</span>}</td>
                  <td>
                    <span className={`pill ${r.status === 'worked' ? 'ok' : r.status === 'absent' ? 'bad' : ''}`}>
                      {scheduleStatusText(r.status)}
                    </span>
                    {r.leave && (
                      <span className="muted small">
                        {' '}
                        {r.leave.type}, {r.leave.paid ? 'paid' : 'unpaid'}
                      </span>
                    )}
                  </td>
                  <td className="num">{r.workedMinutes > 0 ? hm(r.workedMinutes) : ''}</td>
                  <td className="num">{r.lateMinutes > 0 ? `${r.lateMinutes} min` : ''}</td>
                  <td className="num">{r.earlyLeaveMinutes > 0 ? `${r.earlyLeaveMinutes} min` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LeaveTab({ fail, ok, hr }: Say) {
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const [status, setStatus] = useState('');
  const leave = useQuery({
    queryKey: ['leave', status],
    queryFn: () => get<{ data: Leave[] }>(`/leave-requests${status ? `?status=${status}` : ''}`).then((r) => r.data),
  });
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => get<{ data: LeaveType[] }>('/leave-types').then((r) => r.data) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['leave'] });
  const decide = useMutation({
    mutationFn: ({ l, what }: { l: Leave; what: 'approve' | 'reject' | 'cancel' }) => post(`/leave-requests/${l.id}/${what}`),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['plan'] });
    },
    onError: fail,
  });

  const [who, setWho] = useState('');
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [reason, setReason] = useState('');
  const request = useMutation({
    mutationFn: () =>
      post('/leave-requests', { employeeId: Number(who), typeId: Number(typeId), fromDay: from, toDay: to, reason: reason.trim() || null }),
    onSuccess: async () => {
      ok('The request is recorded. Approve it to put it on the plan.');
      setReason('');
      await refresh();
    },
    onError: fail,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [paid, setPaid] = useState(true);
  const addType = useMutation({
    mutationFn: () => post('/leave-types', { code: code.trim(), name: name.trim(), paid }),
    onSuccess: async () => {
      ok('The leave type is added.');
      setCode('');
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['leave-types'] });
    },
    onError: fail,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate();
  };

  return (
    <>
      <section className="card">
        <label className="field">
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All requests</option>
            <option value="pending">Waiting for a decision</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        {(leave.data ?? []).length === 0 ? (
          <p className="muted">{leave.isLoading ? 'Loading…' : 'No leave requests.'}</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Days</th>
                  <th>Kind</th>
                  <th>State</th>
                  {hr && <th />}
                </tr>
              </thead>
              <tbody>
                {(leave.data ?? []).map((l) => (
                  <tr key={l.id} data-testid="leave-row">
                    <td>
                      <strong>{l.employee}</strong>
                      {l.reason && <span className="muted small"> · {l.reason}</span>}
                    </td>
                    <td>{l.fromDay === l.toDay ? l.fromDay : `${l.fromDay} to ${l.toDay}`}</td>
                    <td>
                      {l.type} <span className="muted small">{l.paid ? 'paid' : 'unpaid'}</span>
                    </td>
                    <td>
                      <span className={`pill ${l.status === 'approved' ? 'ok' : l.status === 'rejected' ? 'bad' : ''}`}>{l.status}</span>
                      {l.decidedBy && <span className="muted small"> by {l.decidedBy}</span>}
                    </td>
                    {hr && (
                      <td className="actions">
                        {l.status === 'pending' && (
                          <>
                            <button className="btn primary" onClick={() => decide.mutate({ l, what: 'approve' })}>
                              Approve
                            </button>
                            <button className="btn" onClick={() => decide.mutate({ l, what: 'reject' })}>
                              Reject
                            </button>
                          </>
                        )}
                        {l.status === 'approved' && (
                          <button className="btn ghost" onClick={() => decide.mutate({ l, what: 'cancel' })}>
                            Cancel
                          </button>
                        )}
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
        <>
          <form className="card" onSubmit={submit}>
            <h2>Record a leave request</h2>
            <div className="row">
              <label className="field">
                Person
                <select value={who} onChange={(e) => setWho(e.target.value)} required>
                  <option value="">Choose&hellip;</option>
                  {(employees.data ?? [])
                    .filter((e) => e.active)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                Kind
                <select value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
                  <option value="">Choose&hellip;</option>
                  {(types.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.paid ? 'paid' : 'unpaid'})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                First day
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </label>
              <label className="field">
                Last day
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
              </label>
              <label className="field grow">
                Reason
                <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
              </label>
            </div>
            <button className="btn primary" type="submit" disabled={request.isPending || who === '' || typeId === '' || from > to}>
              Record
            </button>
          </form>
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              addType.mutate();
            }}
          >
            <h2>Kinds of leave</h2>
            {(types.data ?? []).length === 0 ? (
              <p className="muted">None yet: add the first one (for example ANNUAL, paid).</p>
            ) : (
              <p>{(types.data ?? []).map((t) => `${t.name} (${t.paid ? 'paid' : 'unpaid'})`).join(' · ')}</p>
            )}
            <div className="row">
              <label className="field">
                Code
                <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
              </label>
              <label className="field grow">
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </label>
              <label className="check">
                <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Paid leave
              </label>
              <button className="btn" type="submit" disabled={addType.isPending || code.trim() === '' || name.trim() === ''}>
                Add
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}

function ShiftsTab({ fail, ok, hr }: Say) {
  const queryClient = useQueryClient();
  const shifts = useShifts();
  const holidays = useHolidays();
  const [name, setName] = useState('');
  const [startText, setStartText] = useState('08:00');
  const [lengthText, setLengthText] = useState('8:00');
  const [grace, setGrace] = useState('5');
  const startMinute = parseTime(startText);
  const lengthMinutes = parseTime(lengthText, true);
  const graceMinutes = /^\d{1,3}$/.test(grace.trim()) ? Number(grace.trim()) : null;
  const addShift = useMutation({
    mutationFn: () => post('/shifts', { name: name.trim(), startMinute, lengthMinutes, graceMinutes }),
    onSuccess: async () => {
      ok('The shift is added.');
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
    onError: fail,
  });
  const setActive = useMutation({
    mutationFn: (s: Shift) => patch(`/shifts/${s.id}`, { active: !s.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
    onError: fail,
  });

  const [hday, setHday] = useState(today());
  const [hname, setHname] = useState('');
  const addHoliday = useMutation({
    mutationFn: () => post('/holidays', { day: hday, name: hname.trim() }),
    onSuccess: async () => {
      ok('The holiday is added.');
      setHname('');
      await queryClient.invalidateQueries({ queryKey: ['holidays'] });
      await queryClient.invalidateQueries({ queryKey: ['plan'] });
    },
    onError: fail,
  });
  const removeHoliday = useMutation({
    mutationFn: (day: string) => api('DELETE', `/holidays/${day}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holidays'] });
      await queryClient.invalidateQueries({ queryKey: ['plan'] });
    },
    onError: fail,
  });

  return (
    <>
      <section className="card">
        <h2>Shifts</h2>
        {(shifts.data ?? []).length === 0 ? (
          <p className="muted">{shifts.isLoading ? 'Loading…' : 'No shifts yet.'}</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Hours</th>
                  <th className="num">Grace</th>
                  {hr && <th />}
                </tr>
              </thead>
              <tbody>
                {(shifts.data ?? []).map((s) => (
                  <tr key={s.id} className={s.active ? '' : 'off'} data-testid="shift-row">
                    <td>
                      <strong>{s.name}</strong>
                      {!s.active && <span className="pill"> retired</span>}
                    </td>
                    <td>{shiftText(s.startMinute, s.lengthMinutes)}</td>
                    <td className="num">{s.graceMinutes} min</td>
                    {hr && (
                      <td className="actions">
                        <button className="btn ghost" onClick={() => setActive.mutate(s)}>
                          {s.active ? 'Retire' : 'Use again'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hr && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addShift.mutate();
            }}
          >
            <h3>Add a shift</h3>
            <div className="row">
              <label className="field grow">
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                Starts (hh:mm)
                <input value={startText} onChange={(e) => setStartText(e.target.value)} inputMode="numeric" autoComplete="off" />
              </label>
              <label className="field">
                Lasts (hours:minutes)
                <input value={lengthText} onChange={(e) => setLengthText(e.target.value)} inputMode="numeric" autoComplete="off" />
              </label>
              <label className="field">
                Grace (minutes)
                <input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" autoComplete="off" />
              </label>
            </div>
            <p className="muted small">
              {startMinute !== null && lengthMinutes !== null && lengthMinutes > 0
                ? `Runs ${shiftText(startMinute, lengthMinutes)}. A clock-in within the grace is not late.`
                : 'Type times like 08:00 and 8:30.'}
            </p>
            <button
              className="btn primary"
              type="submit"
              disabled={
                addShift.isPending ||
                name.trim() === '' ||
                startMinute === null ||
                lengthMinutes === null ||
                lengthMinutes < 1 ||
                graceMinutes === null
              }
            >
              Add the shift
            </button>
          </form>
        )}
        <p className="muted small">A shift in use is retired, not deleted, so old rosters keep their meaning.</p>
      </section>

      <section className="card">
        <h2>Holidays</h2>
        <p className="muted small">A rostered day that is a holiday is not an absence.</p>
        {(holidays.data ?? []).length === 0 ? (
          <p className="muted">No holidays.</p>
        ) : (
          <ul className="plain">
            {(holidays.data ?? []).map((h) => (
              <li key={h.day} data-testid="holiday-row">
                {h.day}: <strong>{h.name}</strong>
                {hr && (
                  <button className="link" onClick={() => removeHoliday.mutate(h.day)} aria-label={`Remove ${h.name}`}>
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {hr && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addHoliday.mutate();
            }}
          >
            <div className="row">
              <label className="field">
                Day
                <input type="date" value={hday} onChange={(e) => setHday(e.target.value)} required />
              </label>
              <label className="field grow">
                Name
                <input value={hname} onChange={(e) => setHname(e.target.value)} autoComplete="off" />
              </label>
              <button className="btn" type="submit" disabled={addHoliday.isPending || hname.trim() === ''}>
                Add the holiday
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
