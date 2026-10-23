import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { useSettings } from '../../hooks/useTillData';
import { ApiError, api, get, post } from '../../lib/api';
import { fmtLbp, fmtUsd } from '../../lib/money';
import { outbox, type Queued } from '../../lib/outbox';
import { printInBrowser, printOnPrinter } from '../../lib/print';
import type { SaleDetail, SaleListItem } from '../../lib/types';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';
import { VoidSaleDialog } from './VoidSaleDialog';
import { Icon } from '../../components/Icon';

const STATUS: Record<SaleListItem['status'], { label: string; chip: string }> = {
  paid: { label: 'Paid', chip: 'ok' },
  partial: { label: 'Part-paid', chip: 'warn' },
  unpaid: { label: 'On account', chip: 'warn' },
  void: { label: 'Voided', chip: 'danger' },
};
const METHOD: Record<string, string> = { cash: 'Cash', whish: 'Whish', omt: 'OMT' };
const when = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const startOfDay = (daysAgo: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
};

/** Why the server refused a sale that waited on this till, in words for the person who has to deal with it. */
const WHY: Record<string, string> = {
  REGISTER_CLOSED: 'The register was closed when this was sent. Open the register, then try again.',
  PRICE_MISMATCH: 'A price changed while this till was offline.',
  DISCOUNT_OVER_LIMIT: "The discount needed a manager's approval that is no longer valid.",
  CREDIT_REQUIRES_CUSTOMER: 'Part of it was left on account, which needs a registered customer.',
  PRODUCT_INACTIVE: 'A product in it has been taken off sale.',
};

type QueuedBody = {
  items?: unknown[];
  payments?: { method: string; currency: 'USD' | 'LBP'; amount: number }[];
  customerId?: number;
};
/** A sale waiting on this till, in a line. */
function summarize(body: unknown): string {
  const b = (body ?? {}) as QueuedBody;
  const n = b.items?.length ?? 0;
  const paid =
    (b.payments ?? [])
      .map((p) => `${METHOD[p.method] ?? p.method} ${p.currency === 'USD' ? fmtUsd(p.amount) : fmtLbp(p.amount)}`)
      .join(' + ') || 'nothing paid';
  return `${n} item${n === 1 ? '' : 's'} · ${paid}${b.customerId ? " · on a customer's account" : ''}`;
}

function useOutboxItems(): Queued[] {
  const [items, setItems] = useState<Queued[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void outbox.list().then((i) => live && setItems(i));
    load();
    const off = outbox.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return items;
}

/** Sales that happened but are not in the system yet, and the recent ones that are: find a sale, reprint it, start a return. */
export function SalesPage() {
  const user = useSession((s) => s.user)!;
  const isManager = user.role === 'manager' || user.role === 'admin';
  const [refText, setRefText] = useState('');
  const [ref, setRef] = useState<number | null>(null);
  const [range, setRange] = useState<'today' | 'week' | 'all'>('today');
  const [open, setOpen] = useState<SaleListItem | null>(null);
  const [error, setError] = useState('');

  const from = range === 'today' ? startOfDay(0) : range === 'week' ? startOfDay(6) : undefined;
  const sales = useInfiniteQuery({
    queryKey: ['sales', ref, ref ? 'any' : range],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '30' });
      if (ref) q.set('ref', String(ref));
      else if (from) q.set('from', from);
      if (pageParam) q.set('cursor', String(pageParam));
      return get<{ data: SaleListItem[]; nextCursor: number | null }>(`/sales?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = sales.data?.pages.flatMap((p) => p.data) ?? [];

  function find(e: FormEvent) {
    e.preventDefault();
    const t = refText.trim();
    if (t === '') {
      setError('');
      return setRef(null);
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n <= 0) return setError('Type the number printed on the receipt');
    setError('');
    setRef(n);
  }

  return (
    <main className="page">
      <h1>
        <Icon name="sales" size={26} />
        Sales
      </h1>
      <NotSentYet isManager={isManager} />

      <h2>Recent sales</h2>
      <form className="toolbar" onSubmit={find}>
        <label className="field">
          Receipt number
          <input
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Find one sale"
          />
        </label>
        <button className="btn" type="submit">
          {refText.trim() ? 'Find' : 'Show all'}
        </button>
        <label className="field">
          Show
          <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} disabled={ref !== null}>
            <option value="today">Today</option>
            <option value="week">The last 7 days</option>
            <option value="all">Everything</option>
          </select>
        </label>
      </form>
      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}
      {!isManager && <p className="muted">You see the sales you made. A manager sees everyone's.</p>}

      {sales.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">{ref ? `There is no sale of yours with receipt number ${ref}.` : 'No sales in this time.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>When</th>
              <th>Customer</th>
              {isManager && <th>Cashier</th>}
              <th className="num">Total</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} data-testid="sale-row">
                <td>{s.ref}</td>
                <td className="muted">{when(s.createdAt)}</td>
                <td>{s.customerName}</td>
                {isManager && <td className="muted">{s.userName ?? ''}</td>}
                <td className="num">{fmtLbp(s.totalLbp)}</td>
                <td>
                  <span className={`chip ${STATUS[s.status].chip}`}>{STATUS[s.status].label}</span>
                  {s.restLbp > 0 && s.status !== 'void' && <span className="muted">{` ${fmtLbp(s.restLbp)} owed`}</span>}
                </td>
                <td className="num">
                  <button className="btn small" onClick={() => setOpen(s)} aria-label={`Open receipt ${s.ref}`}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sales.hasNextPage && (
        <p>
          <button className="btn" disabled={sales.isFetchingNextPage} onClick={() => void sales.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
      {open && <SaleDialog sale={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

// ------------------------------------------------------------------ sales that have not reached the server

function NotSentYet({ isManager }: { isManager: boolean }) {
  const queryClient = useQueryClient();
  const items = useOutboxItems();
  const [discarding, setDiscarding] = useState<Queued | null>(null);
  const [busy, setBusy] = useState(false);
  if (items.length === 0) return null;

  const refresh = () => Promise.all(['sales', 'register', 'alerts'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
      const left = await outbox.counts();
      if (left.waiting + left.blocked === 0) toast.success('Everything has been sent');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="banner warn" aria-label="Sales not sent yet" data-testid="not-sent">
      <div className="title">{`Not in the system yet: ${items.length} ${items.length === 1 ? 'sale' : 'sales'}`}</div>
      <div className="muted">
        These happened on this till but the server has not recorded them. Until it does, they are in no report and not in the register.
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {items.map((i) => (
          <li key={i.id} data-testid="queued-sale" style={{ display: 'grid', gap: 4 }}>
            <div>
              <strong>{when(i.createdAt)}</strong> · {summarize(i.body)}
            </div>
            {i.blocked ? (
              <>
                <div role="alert" data-testid="queued-reason">
                  <strong>Refused.</strong> {WHY[i.blocked.code] ?? i.blocked.detail}
                </div>
                <div className="buttons">
                  <button
                    className="btn small primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await outbox.retry(i.id);
                        return outbox.flush();
                      })
                    }
                  >
                    Try again
                  </button>
                  {isManager ? (
                    <button className="btn small danger" disabled={busy} onClick={() => setDiscarding(i)}>
                      Discard…
                    </button>
                  ) : (
                    <span className="muted">Only a manager can discard a sale.</span>
                  )}
                </div>
              </>
            ) : (
              <div className="buttons">
                <span className="muted">{i.attempts > 0 ? `Waiting for the server (${i.attempts} tries)` : 'Waiting for the server'}</span>
                <button className="btn small" disabled={busy} onClick={() => void run(() => outbox.flush())}>
                  Send now
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {discarding && (
        <DiscardDialog
          item={discarding}
          onClose={() => setDiscarding(null)}
          onDone={() => {
            setDiscarding(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * Throwing a sale away is the one way a sale can disappear, so it asks why, says what it means, and tells the server (the
 * server keeps a note of who discarded what). Only a manager gets here.
 */
function DiscardDialog({ item, onClose, onDone }: { item: Queued; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function discard(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setError('Say why the sale is being discarded');
    setBusy(true);
    setError('');
    try {
      await post('/sales/queued-discard', {
        clientSaleId: item.id,
        reason: reason.trim(),
        summary: `${when(item.createdAt)} · ${summarize(item.body)}`,
      });
      await outbox.discard(item.id);
      toast.info('The sale was discarded, and the server has a note of it');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SALE_ALREADY_RECORDED') {
        // It reached the server after all. Sending it again simply returns the recorded sale: nothing to discard.
        await outbox.retry(item.id);
        await outbox.flush();
        toast.success(err.message);
        return onDone();
      }
      setError(err instanceof ApiError ? err.message : 'The sale could not be discarded');
      setBusy(false);
    }
  }

  return (
    <Modal label="Discard this sale" onClose={onClose}>
      <form onSubmit={discard} style={{ display: 'grid', gap: 14 }}>
        <h2>Discard this sale?</h2>
        <div className="banner warn">
          <div className="title">{`${when(item.createdAt)} · ${summarize(item.body)}`}</div>
          <div>
            This sale was never recorded. If you discard it, the goods and the money for it will not appear in any report or in the
            register's balance. Do this only if the sale did not really happen, or you are entering it another way.
          </div>
        </div>
        <label className="field">
          Why?
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus autoComplete="off" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button type="submit" className="btn danger big" disabled={busy}>
            Discard the sale
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ one sale

function SaleDialog({ sale, onClose }: { sale: SaleListItem; onClose: () => void }) {
  const navigate = useNavigate();
  const settings = useSettings().data;
  const receipt = useQuery({ queryKey: ['receipt', sale.id], queryFn: () => api<string>('GET', `/sales/${sale.id}/receipt?format=text`) });
  const detail = useQuery({ queryKey: ['sale', sale.id], queryFn: () => get<SaleDetail>(`/sales/${sale.id}`) });
  const [printing, setPrinting] = useState<'idle' | 'busy' | 'done'>('idle');
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState('');

  async function printAgain() {
    setPrinting('busy');
    setProblem('');
    try {
      await printOnPrinter(sale.id, true);
      setPrinting('done');
    } catch (err) {
      setPrinting('idle');
      setProblem(`The receipt did not print: ${err instanceof ApiError ? err.message : 'the printer did not answer'}`);
    }
  }
  async function inBrowser() {
    try {
      await printInBrowser(sale.id, true);
    } catch {
      toast.error('The browser could not open a print window');
    }
  }

  const voided = sale.status === 'void';
  return (
    <Modal label={`Receipt ${sale.ref}`} onClose={onClose}>
      {cancelling && <VoidSaleDialog sale={sale} onClose={() => setCancelling(false)} onDone={onClose} />}
      <div style={{ display: 'grid', gap: 12 }}>
        <h2>{`Receipt ${sale.ref}`}</h2>
        {voided && <div className="banner warn">This sale was voided.</div>}
        {receipt.isLoading ? (
          <p className="muted">Loading…</p>
        ) : (
          <pre className="receipt-text" data-testid="receipt-text">
            {receipt.data}
          </pre>
        )}
        <p className="muted" style={{ margin: 0 }}>
          A reprint says DUPLICATE on it, does not open the cash drawer, and is recorded.
        </p>
        {problem && (
          <div className="warning" role="alert">
            {problem}
          </div>
        )}
        <div className="dialog-actions">
          {!voided && (
            <button className="btn danger" onClick={() => setCancelling(true)} disabled={detail.isLoading}>
              <Icon name="cancel" size={18} />
              Cancel this sale…
            </button>
          )}
          {!voided && (
            <button
              className="btn"
              style={{ marginInlineEnd: 'auto' }}
              onClick={() => navigate(`/returns?ref=${sale.ref}`)}
              disabled={detail.isLoading}
            >
              <Icon name="returns" size={18} />
              Return items…
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" onClick={() => void inBrowser()}>
            <Icon name="print" size={18} />
            Print in browser
          </button>
          {settings?.printerConfigured && (
            <button className="btn primary" disabled={printing === 'busy'} onClick={() => void printAgain()}>
              <Icon name="print" size={18} />
              {printing === 'done' ? 'Printed. Print again' : 'Print again'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
