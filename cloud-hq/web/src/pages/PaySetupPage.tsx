import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../lib/api';
import { bpText, money, parseBp, parseMinor } from '../lib/format';
import { useEmployees } from './PeoplePage';

type Profile = {
  id: number;
  effectiveFrom: string;
  type: 'monthly' | 'daily' | 'hourly';
  baseMinor: number;
  currency: string;
  overtimeAfterMinutes: number | null;
  overtimeBp: number;
  ruleCodes: string[];
};
type Rule = {
  id: number;
  code: string;
  name: string;
  kind: 'percent' | 'brackets';
  side: 'employee' | 'employer';
  base: string;
  currency: string;
  rateBp: number;
  capBaseMinor: number | null;
  brackets: { fromMinor: number; rateBp: number }[];
  effectiveFrom: string;
};
type Loan = {
  id: number;
  employeeId: number;
  principalMinor: number;
  currency: string;
  installmentMinor: number;
  repaidMinor: number;
  remainingMinor: number;
  note: string | null;
};

const today = () => new Date().toISOString().slice(0, 10);
const UNIT = { monthly: 'per month', daily: 'per day', hourly: 'per hour' } as const;

/** How each person is paid, the dated rules (NSSF, tax) the accountant maintains, and loans. Nothing here is ever edited: a change is a new row from a day on. */
export function PaySetupPage() {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fail = (e: unknown) => {
    setNotice('');
    setError(e instanceof ApiError ? e.message : 'That could not be done.');
  };
  const ok = (m: string) => {
    setError('');
    setNotice(m);
  };
  return (
    <div className="stack">
      <h1>Pay setup</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      <Profiles fail={fail} ok={ok} />
      <Rules fail={fail} ok={ok} />
      <Loans fail={fail} ok={ok} />
    </div>
  );
}
type Say = { fail: (e: unknown) => void; ok: (m: string) => void };

function Profiles({ fail, ok }: Say) {
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => get<{ data: Rule[] }>('/payroll/rules').then((r) => r.data) });
  const [who, setWho] = useState('');
  const profiles = useQuery({
    queryKey: ['profiles', who],
    queryFn: () => get<{ data: Profile[] }>(`/employees/${who}/pay-profiles`).then((r) => r.data),
    enabled: who !== '',
  });
  const [from, setFrom] = useState(today());
  const [type, setType] = useState<'monthly' | 'daily' | 'hourly'>('monthly');
  const [cur, setCur] = useState('LBP');
  const [base, setBase] = useState('');
  const [otAfter, setOtAfter] = useState('');
  const [otPct, setOtPct] = useState('150');
  const [picked, setPicked] = useState<string[]>([]);
  const minor = parseMinor(base, cur);
  const bp = parseBp(otPct, 100_000);
  const after = otAfter.trim() === '' ? null : /^\d{1,4}$/.test(otAfter.trim()) ? Number(otAfter.trim()) : NaN;
  const codes = [...new Set((rules.data ?? []).map((r) => r.code))];
  const save = useMutation({
    mutationFn: () =>
      post(`/employees/${who}/pay-profiles`, {
        effectiveFrom: from,
        type,
        baseMinor: minor,
        currency: cur,
        overtimeAfterMinutes: after,
        overtimeBp: bp,
        ruleCodes: picked,
      }),
    onSuccess: async () => {
      ok('The new pay is saved from that day. The old one stays on record.');
      setBase('');
      await queryClient.invalidateQueries({ queryKey: ['profiles', who] });
    },
    onError: fail,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <section className="card">
      <h2>How a person is paid</h2>
      <label className="field">
        Person
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose&hellip;</option>
          {(employees.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      {who !== '' && (
        <>
          {(profiles.data ?? []).length === 0 ? (
            <p className="muted">No pay set yet: payroll skips this person until there is one.</p>
          ) : (
            <ul className="plain">
              {(profiles.data ?? []).map((p, i) => (
                <li key={p.id}>
                  From {p.effectiveFrom}: <strong>{money(p.baseMinor, p.currency)}</strong> {UNIT[p.type]}
                  {p.overtimeAfterMinutes !== null && `, overtime after ${p.overtimeAfterMinutes} min at ${bpText(p.overtimeBp)}`}
                  {p.ruleCodes.length > 0 && <span className="muted small"> · {p.ruleCodes.join(', ')}</span>}
                  {i === 0 && <span className="pill"> newest</span>}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submit}>
            <div className="row">
              <label className="field">
                From
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </label>
              <label className="field">
                Paid
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value === 'daily' ? 'daily' : e.target.value === 'hourly' ? 'hourly' : 'monthly')}
                >
                  <option value="monthly">monthly</option>
                  <option value="daily">daily</option>
                  <option value="hourly">hourly</option>
                </select>
              </label>
              <label className="field">
                Currency
                <select value={cur} onChange={(e) => setCur(e.target.value)}>
                  <option>LBP</option>
                  <option>USD</option>
                </select>
              </label>
              <label className="field">
                Amount ({UNIT[type]})
                <input value={base} onChange={(e) => setBase(e.target.value)} inputMode="decimal" autoComplete="off" />
              </label>
              <label className="field">
                Overtime after (minutes a day, empty = none)
                <input value={otAfter} onChange={(e) => setOtAfter(e.target.value)} inputMode="numeric" autoComplete="off" />
              </label>
              <label className="field">
                Overtime pays (% of normal)
                <input value={otPct} onChange={(e) => setOtPct(e.target.value)} inputMode="decimal" autoComplete="off" />
              </label>
            </div>
            {codes.length > 0 && (
              <fieldset className="checks">
                <legend className="muted small">Rules that apply to this person</legend>
                {codes.map((c) => (
                  <label key={c} className="check">
                    <input
                      type="checkbox"
                      checked={picked.includes(c)}
                      onChange={() => setPicked(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c])}
                    />{' '}
                    {c}
                  </label>
                ))}
              </fieldset>
            )}
            <button
              className="btn primary"
              type="submit"
              disabled={save.isPending || minor === null || minor < 1 || bp === null || Number.isNaN(after)}
            >
              Save from this day
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function Rules({ fail, ok }: Say) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => get<{ data: Rule[] }>('/payroll/rules').then((r) => r.data) });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'percent' | 'brackets'>('percent');
  const [side, setSide] = useState<'employee' | 'employer'>('employee');
  const [cur, setCur] = useState('LBP');
  const [rate, setRate] = useState('');
  const [cap, setCap] = useState('');
  const [table, setTable] = useState('');
  const [from, setFrom] = useState(today());
  const [reduces, setReduces] = useState(false);

  // Brackets, one per line: "from rate", the amount a bracket starts at and the percent charged above it ("0 4", "9000000 10").
  const parsed = table
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [f, r] = l.split(/\s+/);
      return { fromMinor: parseMinor(f ?? '', cur), rateBp: parseBp(r ?? '') };
    });
  const bracketsOk = parsed.length > 0 && parsed.every((b) => b.fromMinor !== null && b.rateBp !== null);
  const capMinor = cap.trim() === '' ? null : parseMinor(cap, cur);
  const rateBp = parseBp(rate);
  const valid =
    code.trim() !== '' &&
    name.trim() !== '' &&
    (kind === 'percent' ? rateBp !== null && (cap.trim() === '' || capMinor !== null) : bracketsOk);
  const save = useMutation({
    mutationFn: () =>
      post('/payroll/rules', {
        code: code.trim(),
        name: name.trim(),
        kind,
        side,
        currency: cur,
        reducesTax: reduces,
        effectiveFrom: from,
        ...(kind === 'percent' ? { rateBp, capBaseMinor: capMinor } : { brackets: parsed }),
      }),
    onSuccess: async () => {
      ok('The rule is saved from that day. Older rules stay on record.');
      setCode('');
      setName('');
      setRate('');
      setCap('');
      setTable('');
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: fail,
  });
  return (
    <section className="card">
      <h2>Rules (NSSF, tax)</h2>
      <p className="muted small">
        Rates are not built into the system: the accountant adds them here, from a day on, and checks the first payroll against their own
        figures.
      </p>
      {(rules.data ?? []).length === 0 ? (
        <p className="muted">No rules yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Paid by</th>
                <th>Rate</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {(rules.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.code}</code>
                  </td>
                  <td>{r.name}</td>
                  <td>{r.side}</td>
                  <td>
                    {r.kind === 'percent'
                      ? `${bpText(r.rateBp)}${r.capBaseMinor !== null ? ` up to ${money(r.capBaseMinor, r.currency)}` : ''}`
                      : r.brackets.map((b) => `${money(b.fromMinor, r.currency)}: ${bpText(b.rateBp)}`).join(' · ')}
                  </td>
                  <td>{r.effectiveFrom}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h3>Add a rule</h3>
        <div className="row">
          <label className="field">
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
          </label>
          <label className="field grow">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value === 'brackets' ? 'brackets' : 'percent')}>
              <option value="percent">a percent</option>
              <option value="brackets">brackets (tax)</option>
            </select>
          </label>
          <label className="field">
            Paid by
            <select value={side} onChange={(e) => setSide(e.target.value === 'employer' ? 'employer' : 'employee')}>
              <option value="employee">the employee (deducted)</option>
              <option value="employer">the employer (extra cost)</option>
            </select>
          </label>
          <label className="field">
            Currency
            <select value={cur} onChange={(e) => setCur(e.target.value)}>
              <option>LBP</option>
              <option>USD</option>
            </select>
          </label>
          <label className="field">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
        </div>
        {kind === 'percent' ? (
          <div className="row">
            <label className="field">
              Rate (%)
              <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" autoComplete="off" />
            </label>
            <label className="field">
              Only on pay up to (empty = no limit)
              <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" autoComplete="off" />
            </label>
          </div>
        ) : (
          <label className="field">
            Brackets, one per line: where it starts, then the percent (for example &ldquo;0 4&rdquo;)
            <textarea rows={4} value={table} onChange={(e) => setTable(e.target.value)} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={reduces} onChange={(e) => setReduces(e.target.checked)} /> Reduces the pay that tax is worked out
          on
        </label>
        <p>
          <button className="btn primary" type="submit" disabled={save.isPending || !valid}>
            Save from this day
          </button>
        </p>
      </form>
    </section>
  );
}

function Loans({ fail, ok }: Say) {
  const queryClient = useQueryClient();
  const employees = useEmployees();
  const loans = useQuery({ queryKey: ['loans'], queryFn: () => get<{ data: Loan[] }>('/loans').then((r) => r.data) });
  const [who, setWho] = useState('');
  const [cur, setCur] = useState('LBP');
  const [principal, setPrincipal] = useState('');
  const [inst, setInst] = useState('');
  const [note, setNote] = useState('');
  const p = parseMinor(principal, cur);
  const i = parseMinor(inst, cur);
  const name = (id: number) => (employees.data ?? []).find((e) => e.id === id)?.name ?? `Employee ${id}`;
  const save = useMutation({
    mutationFn: () =>
      post('/loans', { employeeId: Number(who), principalMinor: p, currency: cur, installmentMinor: i, note: note.trim() || null }),
    onSuccess: async () => {
      ok('The loan is recorded. Each payroll run takes one installment until it is repaid.');
      setPrincipal('');
      setInst('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
    },
    onError: fail,
  });
  return (
    <section className="card">
      <h2>Loans and advances</h2>
      {(loans.data ?? []).length === 0 ? (
        <p className="muted">No loans.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th className="num">Lent</th>
                <th className="num">Installment</th>
                <th className="num">Still owed</th>
              </tr>
            </thead>
            <tbody>
              {(loans.data ?? []).map((l) => (
                <tr key={l.id} className={l.remainingMinor === 0 ? 'off' : ''}>
                  <td>
                    {name(l.employeeId)}
                    {l.note && <span className="muted small"> · {l.note}</span>}
                  </td>
                  <td className="num">{money(l.principalMinor, l.currency)}</td>
                  <td className="num">{money(l.installmentMinor, l.currency)}</td>
                  <td className="num">{money(l.remainingMinor, l.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h3>Record a loan</h3>
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
            Currency
            <select value={cur} onChange={(e) => setCur(e.target.value)}>
              <option>LBP</option>
              <option>USD</option>
            </select>
          </label>
          <label className="field">
            Amount lent
            <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" autoComplete="off" />
          </label>
          <label className="field">
            Taken off each payroll
            <input value={inst} onChange={(e) => setInst(e.target.value)} inputMode="decimal" autoComplete="off" />
          </label>
          <label className="field grow">
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={save.isPending || who === '' || p === null || p < 1 || i === null || i < 1}>
          Record
        </button>
      </form>
    </section>
  );
}
