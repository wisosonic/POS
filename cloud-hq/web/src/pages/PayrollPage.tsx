import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api, get, post } from '../lib/api';
import { hm, money, parseMinor, RUN_STEPS, RUN_WORDS } from '../lib/format';
import { useEmployees } from './PeoplePage';

type Total = {
  currency: string;
  payslips: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
};
type Run = {
  id: number;
  fromDay: string;
  toDay: string;
  status: (typeof RUN_STEPS)[number];
  note: string | null;
  warnings: { employeeId: number | null; code: string; message: string }[];
  totals: Total[];
};
type Line = { side: string; code: string; label: string; amountMinor: number };
type Slip = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  currency: string;
  daysWorked: number;
  regularMinutes: number;
  overtimeMinutes: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  lines: Line[];
};
type Input = { id: number; employeeId: number; kind: 'earning' | 'deduction'; label: string; amountMinor: number };
type RunFull = Run & { payslips: Slip[]; inputs: Input[] };
type Step = 'calculate' | 'approve' | 'pay' | 'lock';

const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/** Pay is the most sensitive data HQ holds: this page is for payroll and admin only (the server refuses everyone else). Amounts stay on this screen. */
export function PayrollPage() {
  const [openId, setOpenId] = useState<number | null>(null);
  return openId === null ? <Runs onOpen={setOpenId} /> : <RunView id={openId} onBack={() => setOpenId(null)} />;
}

function Runs({ onOpen }: { onOpen: (id: number) => void }) {
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => get<{ data: Run[] }>('/payroll/runs').then((r) => r.data) });
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: () => post<{ id: number }>('/payroll/runs', { fromDay: from, toDay: to }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      onOpen(r.id);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That could not be done.'),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    create.mutate();
  }
  return (
    <div className="stack">
      <h1>Payroll</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <section className="card">
        {runs.isLoading ? (
          <p className="muted">Loading&hellip;</p>
        ) : (runs.data ?? []).length === 0 ? (
          <p className="muted">No payroll runs yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>State</th>
                  <th className="num">Net pay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(runs.data ?? []).map((r) => (
                  <tr key={r.id} data-testid="run-row">
                    <td>
                      {r.fromDay} to {r.toDay}
                    </td>
                    <td>
                      <span className={`pill ${r.status === 'locked' || r.status === 'paid' ? 'ok' : ''}`}>{r.status}</span>
                    </td>
                    <td className="num">{r.totals.map((t) => money(t.netMinor, t.currency)).join(' + ') || '-'}</td>
                    <td className="actions">
                      <button className="btn" onClick={() => onOpen(r.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <form className="card" onSubmit={submit}>
        <h2>Start a payroll run</h2>
        <div className="row">
          <label className="field">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <button className="btn primary" type="submit" disabled={create.isPending}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}

function RunView({ id, onBack }: { id: number; onBack: () => void }) {
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const run = useQuery({ queryKey: ['run', id], queryFn: () => get<RunFull>(`/payroll/runs/${id}`) });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openSlip, setOpenSlip] = useState<number | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['run', id] });
    await queryClient.invalidateQueries({ queryKey: ['runs'] });
  };
  const fail = (e: unknown) => {
    setNotice('');
    setError(e instanceof ApiError ? e.message : 'That could not be done.');
  };
  const name = (eid: number) => (employees.data ?? []).find((e) => e.id === eid)?.name ?? `Employee ${eid}`;

  const step = useMutation({
    mutationFn: (what: Step) => post<{ payslips?: number; skipped?: { message: string }[] }>(`/payroll/runs/${id}/${what}`),
    onSuccess: async (r, what) => {
      setError('');
      setNotice(
        what === 'calculate'
          ? `Worked out ${r.payslips ?? 0} payslip${r.payslips === 1 ? '' : 's'}.${r.skipped?.length ? ` ${r.skipped.length} skipped: see the warnings.` : ''}`
          : `Done: ${what}.`,
      );
      await refresh();
    },
    onError: fail,
  });

  const [who, setWho] = useState('');
  const [kind, setKind] = useState<'earning' | 'deduction'>('earning');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  // The line is in the person's own pay currency: ask HQ which profile is in force for them at the end of the period.
  const profiles = useQuery({
    queryKey: ['profiles', who],
    queryFn: () => get<{ data: { effectiveFrom: string; currency: string }[] }>(`/employees/${who}/pay-profiles`).then((p) => p.data),
    enabled: who !== '',
  });
  const cur = (profiles.data ?? []).find((p) => p.effectiveFrom <= (run.data?.toDay ?? '9999'))?.currency ?? 'LBP';
  const minor = parseMinor(amount, cur);
  const addInput = useMutation({
    mutationFn: () => post(`/payroll/runs/${id}/inputs`, { employeeId: Number(who), kind, label: label.trim(), amountMinor: minor }),
    onSuccess: async () => {
      setError('');
      setLabel('');
      setAmount('');
      await refresh();
    },
    onError: fail,
  });
  const removeInput = useMutation({
    mutationFn: (inputId: number) => api('DELETE', `/payroll/runs/${id}/inputs/${inputId}`),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const printSlip = useMutation({
    mutationFn: (slipId: number) => post<{ url: string }>(`/payroll/payslips/${slipId}/print-link`, { lang: 'en' }),
    onSuccess: (r) => window.open(r.url, '_blank', 'noopener'),
    onError: fail,
  });

  if (run.isLoading) return <p className="muted">Loading&hellip;</p>;
  if (!run.data) return <p className="banner warn">That run could not be loaded.</p>;
  const r = run.data;
  const editable = r.status === 'draft' || r.status === 'calculated';
  const next: { what: Step; label: string }[] =
    r.status === 'draft'
      ? [{ what: 'calculate', label: 'Calculate' }]
      : r.status === 'calculated'
        ? [
            { what: 'calculate', label: 'Calculate again' },
            { what: 'approve', label: 'Approve' },
          ]
        : r.status === 'approved'
          ? [{ what: 'pay', label: 'Mark as paid' }]
          : r.status === 'paid'
            ? [{ what: 'lock', label: 'Lock' }]
            : [];
  const go = (what: Step) => {
    if (
      what !== 'calculate' &&
      what !== 'lock' &&
      !window.confirm(`Are you sure? After "${what}" the figures of this run cannot be changed.`)
    )
      return;
    step.mutate(what);
  };
  const last = next[next.length - 1]?.what;

  return (
    <div className="stack">
      <p>
        <button className="btn ghost" onClick={onBack}>
          &larr; All runs
        </button>
      </p>
      <h1>
        Payroll {r.fromDay} to {r.toDay}
      </h1>
      <ol className="steps" aria-label="Where the run is">
        {RUN_STEPS.map((s) => (
          <li key={s} className={s === r.status ? 'now' : RUN_STEPS.indexOf(s) < RUN_STEPS.indexOf(r.status) ? 'past' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <p className="muted">{RUN_WORDS[r.status]}</p>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      {r.warnings.length > 0 && (
        <div className="banner warn">
          <strong>Look at these before approving:</strong>
          <ul>
            {r.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        {next.map((n) => (
          <button key={n.what} className={n.what === last ? 'btn primary' : 'btn'} disabled={step.isPending} onClick={() => go(n.what)}>
            {n.label}
          </button>
        ))}
      </div>

      {r.totals.length > 0 && (
        <div className="tiles">
          {r.totals.map((t) => (
            <div className="tile" key={t.currency}>
              <span className="muted">
                {t.currency} · {t.payslips} payslips
              </span>
              <strong>{money(t.netMinor, t.currency)}</strong>
              <span className="muted small">
                gross {money(t.grossMinor, t.currency)} · deductions {money(t.deductionsMinor, t.currency)} · employer contributions{' '}
                {money(t.employerCostMinor, t.currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      <section className="card">
        <h2>Payslips</h2>
        {r.payslips.length === 0 ? (
          <p className="muted">Nothing calculated yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Days</th>
                  <th className="num">Worked</th>
                  <th className="num">Gross</th>
                  <th className="num">Deductions</th>
                  <th className="num">Net</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {r.payslips.flatMap((s) => [
                  <tr key={s.id} data-testid="slip-row">
                    <td>
                      <strong>{s.employeeName}</strong> <span className="muted">{s.employeeCode}</span>
                    </td>
                    <td className="num">{s.daysWorked}</td>
                    <td className="num">
                      {hm(s.regularMinutes + s.overtimeMinutes)}
                      {s.overtimeMinutes > 0 && <span className="muted small"> ({hm(s.overtimeMinutes)} overtime)</span>}
                    </td>
                    <td className="num">{money(s.grossMinor, s.currency)}</td>
                    <td className="num">{money(s.deductionsMinor, s.currency)}</td>
                    <td className="num">
                      <strong>{money(s.netMinor, s.currency)}</strong>
                    </td>
                    <td className="actions">
                      <button
                        className="btn"
                        onClick={() => setOpenSlip(openSlip === s.id ? null : s.id)}
                        aria-expanded={openSlip === s.id}
                      >
                        Lines
                      </button>
                      <button className="btn" disabled={printSlip.isPending} onClick={() => printSlip.mutate(s.id)}>
                        Print
                      </button>
                    </td>
                  </tr>,
                  openSlip === s.id ? (
                    <tr key={`${s.id}-lines`}>
                      <td colSpan={7}>
                        <table className="inner">
                          <tbody>
                            {s.lines.map((l, i) => (
                              <tr key={i}>
                                <td>{l.label}</td>
                                <td className="muted small">{l.side}</td>
                                <td className="num">
                                  {l.side === 'deduction' ? '-' : ''}
                                  {money(l.amountMinor, s.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null,
                ])}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Extra lines for this run</h2>
        <p className="muted small">A bonus or a deduction for one person, in this run only. Calculate again after changing them.</p>
        {r.inputs.length > 0 && (
          <ul className="plain">
            {r.inputs.map((i) => (
              <li key={i.id}>
                {name(i.employeeId)}: {i.kind === 'deduction' ? 'minus' : 'plus'} <strong>{i.amountMinor.toLocaleString('en-US')}</strong>{' '}
                for {i.label}
                {editable && (
                  <button className="link" onClick={() => removeInput.mutate(i.id)} aria-label={`Remove ${i.label}`}>
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addInput.mutate();
            }}
          >
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
                <select value={kind} onChange={(e) => setKind(e.target.value === 'deduction' ? 'deduction' : 'earning')}>
                  <option value="earning">Bonus (plus)</option>
                  <option value="deduction">Deduction (minus)</option>
                </select>
              </label>
              <label className="field grow">
                What for
                <input value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                Amount ({cur})
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
              </label>
              <button
                className="btn"
                type="submit"
                disabled={addInput.isPending || who === '' || label.trim() === '' || minor === null || minor < 1}
              >
                Add
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
