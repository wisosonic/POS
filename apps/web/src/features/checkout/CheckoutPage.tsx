import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { ProductImage } from '../../components/ProductImage';
import { useScanner } from '../../hooks/useScanner';
import { useRate, useSettings } from '../../hooks/useTillData';
import { ApiError, post } from '../../lib/api';
import { catalog } from '../../lib/catalog';
import { approvalCovers, discountPct, needsApproval, type Approval, type Discount } from '../../lib/discount';
import { fmtLbp, trimQty, unitPriceLbp } from '../../lib/money';
import type { PayAnalysis } from '../../lib/payment';
import { outbox } from '../../lib/outbox';
import { beep, printInBrowser, printOnPrinter } from '../../lib/print';
import type { Product, SaleResult } from '../../lib/types';
import { cartTotals, useCart } from '../../store/cart';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';
import { useUi } from '../../store/ui';
import { CartPanel } from './CartPanel';
import { DiscountDialog } from './DiscountDialog';
import { PriceDialog } from './PriceDialog';
import { PayDialog } from './PayDialog';
import { Icon } from '../../components/Icon';
import { useLookup } from '../products/lookups';
import { CatalogBrowser } from './CatalogBrowser';

type PrintState = 'idle' | 'printing' | 'done' | 'failed';
type Done = { kind: 'sale'; sale: SaleResult; print: PrintState; printError?: string } | { kind: 'offline'; total: number };

export function CheckoutPage() {
  const queryClient = useQueryClient();
  const settings = useSettings().data;
  const rate = useRate().data;
  const catalogVersion = useUi((s) => s.catalogVersion);
  const lines = useCart((s) => s.lines);
  const lastKey = useCart((s) => s.lastKey);
  const customer = useCart((s) => s.customer);
  const discount = useCart((s) => s.discount);
  const approval = useCart((s) => s.approval);
  const role = useSession((s) => s.user?.role) ?? 'cashier';

  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [paying, setPaying] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [pricing, setPricing] = useState<string | null>(null);
  const [choices, setChoices] = useState<Product[] | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const categories = useLookup('categories');
  const search = useRef<HTMLInputElement>(null);

  const lbpRounding = settings?.lbpRounding ?? 5000;
  const totals = useMemo(
    () => (rate ? cartTotals(lines, rate, lbpRounding, discount) : cartTotals([], 1, lbpRounding)),
    [lines, rate, lbpRounding, discount],
  );
  const limitPct = settings?.cashierDiscountLimitPct ?? 0;
  const pct = discountPct(totals.discountLbp, totals.subtotalLbp);
  // catalogVersion is how a change of the catalog copy reaches the search results
  const results = useMemo(() => (catalogVersion >= 0 ? catalog.search(text) : []), [text, catalogVersion]);
  const everything = useMemo(() => (browsing && catalogVersion >= 0 ? catalog.all() : []), [browsing, catalogVersion]);
  const last = lines.find((l) => l.key === lastKey);

  // The cart changed under a discount: drop what no longer fits, and say so rather than silently charging a different price.
  useEffect(() => {
    if (totals.discountInvalid) {
      useCart.getState().setDiscount(null);
      toast.info('The discount was taken off because it is more than the cart is now worth');
    }
  }, [totals.discountInvalid]);
  useEffect(() => {
    if (approval && !approvalCovers(approval, pct)) {
      useCart.getState().setApproval(null);
      toast.warning("The cart changed, so the manager's approval no longer covers the discount. Press Discount to ask again.", 7000);
    }
  }, [approval, pct]);

  // ---------------------------------------------------------------- adding things
  function addProduct(p: Product) {
    const line = useCart.getState().add(p);
    setDone(null);
    setChoices(null);
    setFocusKey(p.fractional ? line.key : null);
    beep('ok');
  }

  function addByCode(code: string) {
    const hits = catalog.byCode(code);
    if (hits.length === 0) {
      beep('error');
      toast.error(`Unknown barcode: ${code}`);
    } else if (hits.length === 1) addProduct(hits[0]!);
    else {
      beep('ok');
      setChoices(hits); // the same barcode is on several products: ask which one
    }
  }

  useScanner(addByCode, !paying && !choices);

  function searchEnter() {
    const t = text.trim();
    if (!t) return;
    if (catalog.byCode(t).length > 0) addByCode(t);
    else if (results[highlight]) addProduct(results[highlight]!);
    else {
      beep('error');
      toast.error(`Nothing found for "${t}"`);
    }
    setText('');
    setHighlight(0);
  }

  // ---------------------------------------------------------------- hold, clear, pay
  async function hold() {
    const cart = useCart.getState();
    if (cart.lines.length === 0) return;
    try {
      await post('/holds', {
        customerId: cart.customer?.id,
        items: cart.lines.map((l) => ({ productId: l.product.id, qty: l.qty, priceLbp: unitPriceLbp(l.product, rate ?? 1) })),
      });
      const hadDiscount = cart.discount !== null;
      cart.clear();
      await queryClient.invalidateQueries({ queryKey: ['holds'] });
      toast.success(
        hadDiscount
          ? 'Cart held. The discount is not kept with a held cart: give it again when you bring it back.'
          : 'Cart held. Open Holds to bring it back.',
      );
    } catch (e) {
      toast.error(e instanceof ApiError && e.isNetwork ? 'Cannot hold a cart while offline' : 'Could not hold the cart');
    }
  }
  const clear = () => {
    useCart.getState().clear();
    setDone(null);
  };
  const openDiscount = () => {
    if (useCart.getState().lines.length > 0 && rate) setDiscounting(true);
  };
  const openPay = () => {
    const cart = useCart.getState();
    if (cart.lines.length === 0 || !rate) return;
    // A discount above the cashier's limit has to be approved before the customer pays, not discovered when the sale is refused.
    if (cart.discount && needsApproval(role, pct, limitPct) && !(cart.approval && approvalCovers(cart.approval, pct))) {
      toast.warning('This discount is above your limit: a manager has to approve it before the customer pays.');
      setDiscounting(true);
      return;
    }
    setPaying(true);
  };

  // Keyboard shortcuts for a till with no mouse: F2 search, F4 hold, F6 discount, F9 pay.
  const shortcuts = useRef({ hold, openPay, openDiscount });
  shortcuts.current = { hold, openPay, openDiscount };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key !== 'F2' && e.key !== 'F4' && e.key !== 'F6' && e.key !== 'F9') return;
      e.preventDefault(); // keep the browser's own F-key actions (find, caret browsing) out of the way
      if (e.key === 'F2') search.current?.focus();
      else if (e.key === 'F4') void shortcuts.current.hold();
      else if (e.key === 'F6') shortcuts.current.openDiscount();
      else shortcuts.current.openPay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------------------------------------------------------------- completing the sale
  async function complete(analysis: PayAnalysis) {
    const cart = useCart.getState();
    const priced = new Map(totals.lines.map((l) => [l.key, l.unitPriceLbp]));
    const clientSaleId = crypto.randomUUID();
    const body = {
      clientSaleId,
      customerId: cart.customer?.id,
      items: cart.lines.map((l) => ({
        productId: l.product.id,
        qty: l.qty,
        unitPriceLbp: priced.get(l.key)!,
        ...(l.price?.token ? { approvalToken: l.price.token } : {}),
      })),
      payments: analysis.tenders.map((t) => ({ method: t.method ?? 'cash', currency: t.currency, amount: t.amount })),
      ...(cart.discount ? { discount: cart.discount } : {}),
      ...(cart.discount && cart.approval ? { approvalToken: cart.approval.token } : {}),
    };

    const saveOffline = async () => {
      // Kept on this computer and sent when the server answers again. The same id is the Idempotency-Key, so it can never be recorded twice.
      await outbox.add(clientSaleId, body);
      cart.clear();
      setPaying(false);
      setDone({ kind: 'offline', total: totals.totalLbp });
    };

    if (!navigator.onLine) {
      // An approval is checked by the server, once, within minutes: it cannot wait in the queue for the connection.
      if (cart.approval || cart.lines.some((l) => l.price?.token))
        throw new ApiError(
          0,
          'APPROVAL_NEEDS_SERVER',
          "A discount or price that needed a manager's approval can only be completed while the connection to the server works. Wait for it, or go back to the normal price.",
        );
      return saveOffline();
    }
    try {
      const sale = await post<SaleResult>('/sales', body, { idempotencyKey: clientSaleId });
      cart.clear();
      setPaying(false);
      void queryClient.invalidateQueries({ queryKey: ['register'] });
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      for (const item of sale.lowStock) toast.warning(`Low stock: ${item.name.trim()} (${trimQty(item.qty)} left)`, 6000);
      setDone({ kind: 'sale', sale, print: 'idle' });
      if (settings?.printerConfigured) void print(sale);
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) return saveOffline();
      if (e instanceof ApiError && e.code === 'PRICE_MISMATCH') {
        await catalog.sync().catch(() => undefined); // a price changed since this till last looked: fetch the new ones
        useUi.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
        throw new ApiError(
          e.status,
          e.code,
          'A price changed while you were selling. The cart has been updated: check the total and complete again.',
        );
      }
      if (e instanceof ApiError && e.code === 'DISCOUNT_OVER_LIMIT') {
        // Expired, already used, or for a smaller discount: the approval is spent. Ask again rather than retry the same one.
        useCart.getState().setApproval(null);
        throw new ApiError(
          e.status,
          e.code,
          "The manager's approval is no longer valid (it may have expired). Close this, press Discount and ask a manager again.",
        );
      }
      if (e instanceof ApiError && e.code === 'REGISTER_CLOSED') {
        void queryClient.invalidateQueries({ queryKey: ['register'] });
        setPaying(false);
      }
      throw e;
    }
  }

  async function print(sale: SaleResult, duplicate = false) {
    setDone((d) => (d?.kind === 'sale' && d.sale.id === sale.id ? { ...d, print: 'printing' } : d));
    try {
      await printOnPrinter(sale.id, duplicate);
      setDone((d) => (d?.kind === 'sale' && d.sale.id === sale.id ? { ...d, print: 'done' } : d));
    } catch (e) {
      // The sale is already saved. Printing is only a convenience, so say so and offer another way.
      const why = e instanceof ApiError ? e.message : 'The printer did not answer';
      setDone((d) => (d?.kind === 'sale' && d.sale.id === sale.id ? { ...d, print: 'failed', printError: why } : d));
    }
  }

  async function browserPrint(sale: SaleResult, duplicate = false) {
    try {
      await printInBrowser(sale.id, duplicate);
    } catch {
      toast.error('The browser could not open a print window');
    }
  }

  const ready = !!rate && !!settings;

  return (
    <main className="checkout" data-testid="checkout">
      <div className="left">
        <div className="search-row">
          <div className="search">
            <Icon name="search" size={24} />
            <input
              ref={search}
              type="search"
              role="searchbox"
              aria-label="Scan or search product"
              placeholder="Scan a barcode or search by name (F2)"
              autoComplete="off"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
                if (e.key === 'Enter') searchEnter();
                else if (e.key === 'ArrowDown') setHighlight((h) => Math.min(h + 1, results.length - 1));
                else if (e.key === 'ArrowUp') setHighlight((h) => Math.max(h - 1, 0));
                else if (e.key === 'Escape') setText('');
              }}
            />
            {!text && (
              <div className="hint-line">The scanner works without clicking anywhere. Items without a barcode: type part of the name.</div>
            )}
          </div>
          <button type="button" className="btn catalog-toggle" aria-pressed={browsing} onClick={() => setBrowsing((b) => !b)}>
            <Icon name="products" size={20} />
            {browsing ? 'Hide catalog' : 'Browse catalog'}
          </button>
        </div>

        {text.trim() !== '' && (
          <ul className="results" role="listbox" aria-label="Search results">
            {results.length === 0 && <li className="empty">No product matches “{text.trim()}”</li>}
            {results.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onClick={() => {
                    addProduct(p);
                    setText('');
                    search.current?.focus();
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <ProductImage product={p} size={44} />
                    <span>
                      <strong>{p.name.trim()}</strong>
                      <div className="meta">
                        {[p.barcode, p.fractional ? `per ${p.unitName ?? 'unit'}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </span>
                  </span>
                  <span className="num">{rate ? fmtLbp(unitPriceLbp(p, rate)) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {text.trim() === '' && done?.kind === 'sale' && (
          <section className="banner ok" aria-label="Last sale">
            <div className="title">{`Sale ${done.sale.ref} completed`}</div>
            <div>
              {fmtLbp(done.sale.totalLbp)}
              {done.sale.changeLbp > 0 && <strong>{` · give back ${fmtLbp(done.sale.changeLbp)}`}</strong>}
              {done.sale.restLbp > 0 && <strong>{` · ${fmtLbp(done.sale.restLbp)} left on account`}</strong>}
            </div>
            <div className="buttons">
              {done.print === 'printing' && <span className="muted">Printing…</span>}
              {done.print === 'done' && <span className="muted">Receipt printed</span>}
              {done.print === 'failed' && (
                <>
                  <span className="muted" style={{ flexBasis: '100%' }}>{`The receipt did not print: ${done.printError}`}</span>
                  <button className="btn small" onClick={() => void print(done.sale)}>
                    Retry print
                  </button>
                  <button className="btn small" onClick={() => void browserPrint(done.sale)}>
                    Print in browser
                  </button>
                </>
              )}
              {done.print === 'idle' && (
                <button className="btn small" onClick={() => void browserPrint(done.sale)}>
                  Print receipt
                </button>
              )}
              {done.print === 'done' && (
                <button className="btn small" onClick={() => void print(done.sale, true)}>
                  Print again
                </button>
              )}
              <button className="btn small ghost" onClick={() => setDone(null)}>
                Dismiss
              </button>
            </div>
          </section>
        )}

        {text.trim() === '' && done?.kind === 'offline' && (
          <section className="banner warn" aria-label="Saved offline">
            <div className="title">Sale saved on this computer</div>
            <div>{`${fmtLbp(done.total)}. It will be sent automatically when the connection is back. You can keep selling.`}</div>
            <div className="buttons">
              <button className="btn small ghost" onClick={() => setDone(null)}>
                Dismiss
              </button>
            </div>
          </section>
        )}

        {/* Kept (but hidden) while a search is typed, so the categories are still open when the search is cleared. */}
        {browsing && (
          <div className="catalog-slot" hidden={text.trim() !== ''}>
            <CatalogBrowser
              products={everything}
              categories={categories.data ?? []}
              rate={rate}
              onPick={(p) => {
                addProduct(p);
                search.current?.focus();
              }}
            />
          </div>
        )}

        {text.trim() === '' && !browsing && !done && last && (
          <section className="last" aria-label="Last item" style={{ position: 'relative' }}>
            {last.product.imagePath && (
              <div style={{ position: 'absolute', top: 12, insetInlineEnd: 12 }}>
                <ProductImage product={last.product} size={96} />
              </div>
            )}
            <div className="muted">Last item</div>
            <div className="name">{last.product.name.trim()}</div>
            <div className="price">
              {rate
                ? `${fmtLbp(unitPriceLbp(last.product, rate))}${last.product.fractional ? ` per ${last.product.unitName ?? 'unit'}` : ''}`
                : ''}
            </div>
            <div className="muted">{`Quantity ${trimQty(last.qty)} · ${last.product.barcode}`}</div>
          </section>
        )}
      </div>

      <div className="right">
        <CartPanel
          lines={lines}
          totals={totals}
          rate={rate ?? 1}
          lastKey={lastKey}
          focusKey={focusKey}
          approvedBy={approval?.managerName ?? null}
          onClear={clear}
          onHold={() => void hold()}
          onPay={openPay}
          onDiscount={openDiscount}
          onRemoveDiscount={() => useCart.getState().setDiscount(null)}
          onPrice={(key) => setPricing(key)}
        />
      </div>

      {discounting && ready && (
        <DiscountDialog
          preview={(d: Discount) => cartTotals(lines, rate, lbpRounding, d)}
          limitPct={limitPct}
          role={role}
          initial={discount}
          onApply={(d: Discount, a: Approval | null) => {
            useCart.getState().setDiscount(d, a);
            setDiscounting(false);
            setDone(null);
          }}
          onRemove={() => {
            useCart.getState().setDiscount(null);
            setDiscounting(false);
          }}
          onClose={() => setDiscounting(false)}
        />
      )}

      {pricing && ready && lines.some((l) => l.key === pricing) && (
        <PriceDialog
          line={lines.find((l) => l.key === pricing)!}
          catalogLbp={unitPriceLbp(lines.find((l) => l.key === pricing)!.product, rate)}
          role={role}
          onApply={(price) => {
            useCart.getState().setPrice(pricing, price);
            setPricing(null);
            setDone(null);
          }}
          onClose={() => setPricing(null)}
        />
      )}

      {paying && ready && (
        <PayDialog
          totalLbp={totals.totalLbp}
          rate={rate}
          lbpRounding={lbpRounding}
          customer={customer}
          onCustomer={(c) => useCart.getState().setCustomer(c)}
          onComplete={complete}
          onClose={() => setPaying(false)}
        />
      )}

      {choices && (
        <Modal label="Choose the product" onClose={() => setChoices(null)}>
          <h2>Several products share this barcode</h2>
          <ul className="options" style={{ maxHeight: 'none' }}>
            {choices.map((p) => (
              <li key={p.id} role="option" aria-selected={false} onClick={() => addProduct(p)}>
                <span>{p.name.trim()}</span>
                <span className="num">{rate ? fmtLbp(unitPriceLbp(p, rate)) : ''}</span>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setChoices(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
