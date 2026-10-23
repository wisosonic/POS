import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { fmtLbp, groupThousands, lbpAsUsd } from '../../lib/money';
import { NO_PAYMENT, analyzePayment, type PayAnalysis, type PayInputs } from '../../lib/payment';
import type { Customer, Method } from '../../lib/types';
import { CustomerPicker } from './CustomerPicker';

const METHODS: { method: Method; name: string; lbp: keyof PayInputs; usd: keyof PayInputs }[] = [
  { method: 'cash', name: 'Cash', lbp: 'cashLbp', usd: 'cashUsd' },
  { method: 'whish', name: 'Whish', lbp: 'whishLbp', usd: 'whishUsd' },
  { method: 'omt', name: 'OMT', lbp: 'omtLbp', usd: 'omtUsd' },
];

/** Round-number bills worth offering as one-tap amounts for a lira payment. */
const NOTES = [50_000, 100_000, 200_000, 500_000, 1_000_000];

type Props = {
  totalLbp: number;
  rate: number;
  lbpRounding: number;
  customer: Customer | null;
  onCustomer: (c: Customer | null) => void;
  /** Sends the sale. Throws an ApiError if it is refused, which is shown here and keeps the dialog open. */
  onComplete: (analysis: PayAnalysis) => Promise<void>;
  onClose: () => void;
};

export function PayDialog({ totalLbp, rate, lbpRounding, customer, onCustomer, onComplete, onClose }: Props) {
  const [inputs, setInputs] = useState<PayInputs>(NO_PAYMENT);
  const [active, setActive] = useState<Method>('cash');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const fields = useRef<Partial<Record<keyof PayInputs, HTMLInputElement | null>>>({});

  const analysis = useMemo(
    () => analyzePayment({ inputs, totalLbp, rate, lbpRounding, registeredCustomer: customer !== null }),
    [inputs, totalLbp, rate, lbpRounding, customer],
  );
  const set = (key: keyof PayInputs, value: string) => {
    setServerError('');
    setInputs((s) => ({ ...s, [key]: value }));
  };
  const typedSomething = Object.values(inputs).some((v) => v.trim() !== '');
  // Before anything is typed, "enter what the customer pays" is a prompt, not a complaint.
  const showWarning = analysis.error !== null && !(analysis.error === 'Enter what the customer pays' && !typedSomething);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (analysis.error || busy) return;
    setBusy(true);
    setServerError('');
    try {
      await onComplete(analysis);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The sale could not be completed');
      setBusy(false);
    }
  }

  return (
    <Modal label="Payment" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>Pay</h2>
        <div className="due">
          <span>Total due</span>
          <div style={{ textAlign: 'right' }}>
            <div className="amount num" data-testid="pay-total">
              {fmtLbp(totalLbp)}
            </div>
            <div className="muted">{`about ${lbpAsUsd(totalLbp, rate)}`}</div>
          </div>
        </div>

        <CustomerPicker value={customer} onChange={onCustomer} />

        <div className="tabs" role="tablist" aria-label="Payment method">
          {METHODS.map((m) => (
            <button
              key={m.method}
              type="button"
              role="tab"
              aria-selected={active === m.method}
              onClick={() => {
                setActive(m.method);
                fields.current[m.lbp]?.focus();
              }}
            >
              {m.name}
            </button>
          ))}
        </div>

        {METHODS.map((m) => (
          <div key={m.method} className={`method ${active === m.method ? 'active' : ''}`}>
            <label className="field">
              {`${m.name} LBP`}
              <input
                ref={(el) => void (fields.current[m.lbp] = el)}
                className="num"
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                value={inputs[m.lbp]}
                onFocus={() => setActive(m.method)}
                onChange={(e) => set(m.lbp, e.target.value)}
              />
            </label>
            <label className="field">
              {`${m.name} USD`}
              <input
                ref={(el) => void (fields.current[m.usd] = el)}
                className="num"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={inputs[m.usd]}
                onFocus={() => setActive(m.method)}
                onChange={(e) => set(m.usd, e.target.value)}
              />
            </label>
            {active === m.method && (
              <div className="quick">
                <button type="button" className="btn small" onClick={() => set(m.lbp, String(totalLbp))}>
                  Exact
                </button>
                {m.method === 'cash' &&
                  NOTES.filter((n) => n >= totalLbp)
                    .slice(0, 3)
                    .map((n) => (
                      <button key={n} type="button" className="btn small" onClick={() => set(m.lbp, String(n))}>
                        {groupThousands(n)}
                      </button>
                    ))}
              </div>
            )}
          </div>
        ))}

        <div className="summary" aria-live="polite">
          <div className="row">
            <span>Received</span>
            <span className="num">{fmtLbp(analysis.receivedLbp)}</span>
          </div>
          <div className="row big change">
            <span>Change (cash)</span>
            <span className="num" data-testid="change-due">
              {fmtLbp(analysis.changeLbp)}
            </span>
          </div>
          {analysis.restLbp > 0 && (
            <div className="row big rest">
              <span>Left on account</span>
              <span className="num" data-testid="rest-due">
                {fmtLbp(analysis.restLbp)}
              </span>
            </div>
          )}
        </div>

        {showWarning && (
          <div className="warning" role="alert">
            {analysis.error}
          </div>
        )}
        {serverError && (
          <div className="warning" role="alert">
            {serverError}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary big" disabled={analysis.error !== null || busy}>
            Complete
          </button>
        </div>
      </form>
    </Modal>
  );
}
