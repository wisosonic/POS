import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import { groupThousands, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, Method } from '../../lib/types';
import { tNow, useT } from '../../store/lang';

type Suggestion = { balances: { method: Method; currency: Currency; amount: number }[] };

// Only cash belongs to a till. Whish and OMT belong to the branch and are counted by a manager (docs/13-branch-wallets.md).
const METHODS: { method: Method; name: string }[] = [{ method: 'cash', name: 'Cash' }];
const keyOf = (m: Method, c: Currency) => `${m}/${c}`;

/**
 * The cashier counts the cash in the drawer, in both currencies, and types it in, pre-filled from what this till counted when it
 * last closed.
 */
export function OpenRegisterDialog() {
  const t = useT();
  const queryClient = useQueryClient();
  const suggestion = useQuery({
    queryKey: ['suggested-opening'],
    queryFn: () => get<Suggestion>('/registers/suggested-opening'),
    staleTime: 0,
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!suggestion.data) return;
    const v: Record<string, string> = {};
    for (const b of suggestion.data.balances)
      v[keyOf(b.method, b.currency)] = b.amount === 0 ? '' : b.currency === 'USD' ? String(b.amount / 100) : groupThousands(b.amount);
    setValues(v);
  }, [suggestion.data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const openingBalances = [];
    for (const { method, name } of METHODS) {
      for (const currency of ['USD', 'LBP'] as const) {
        const text = values[keyOf(method, currency)] ?? '';
        const amount = currency === 'USD' ? parseUsdInput(text) : parseLbpInput(text);
        if (Number.isNaN(amount)) return setError(tNow('Check the amount in {field}', { field: `${tNow(name)} ${currency}` }));
        openingBalances.push({ method, currency, amount });
      }
    }
    setBusy(true);
    setError('');
    try {
      await post('/registers/open', { openingBalances });
    } catch (err) {
      // Already open (another screen opened it a moment ago) is fine: just show it.
      if (!(err instanceof ApiError && err.code === 'REGISTER_ALREADY_OPEN')) {
        setError(err instanceof ApiError ? err.message : tNow('Could not open the register'));
        setBusy(false);
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['register'] });
    setBusy(false);
  }

  return (
    <Modal label={t('Open register')} dismissible={false}>
      <form onSubmit={submit} className="dialog-body" style={{ padding: 0 }}>
        <h2>{t('Open the register')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t('Count the cash in the drawer, then type it in.')}
        </p>
        {METHODS.map(({ method, name }) => (
          <div key={method} className="method">
            {(['LBP', 'USD'] as const).map((currency) => (
              <label key={currency} className="field">
                {`${t(name)} ${currency}`}
                <input
                  className="num"
                  inputMode="decimal"
                  value={values[keyOf(method, currency)] ?? ''}
                  placeholder="0"
                  onChange={(e) => setValues((v) => ({ ...v, [keyOf(method, currency)]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        ))}
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn primary big" type="submit" disabled={busy || suggestion.isLoading}>
            {t('Open register')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
