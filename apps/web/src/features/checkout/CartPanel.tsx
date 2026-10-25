import { useEffect, useRef } from 'react';
import { fmtLbp, lbpAsUsd, trimQty } from '../../lib/money';
import { useCart, type CartLine, type CartTotals } from '../../store/cart';
import { toast } from '../../store/toast';
import { tNow, useT } from '../../store/lang';
import { Icon } from '../../components/Icon';

function QtyBox({ line, autoFocus }: { line: CartLine; autoFocus: boolean }) {
  const t = useT();
  const step = useCart((s) => s.step);
  const setQty = useCart((s) => s.setQty);
  const input = useRef<HTMLInputElement>(null);

  // A weighed item is added at 1 kg: put the cursor in the box so the cashier can type the real weight straight away.
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [autoFocus]);

  const commit = (text: string) => {
    const typed = text.trim();
    if (typed === trimQty(line.qty)) return;
    if (!setQty(line.key, typed)) {
      toast.warning(
        line.product.fractional
          ? tNow('Enter a quantity such as 2 or 0.35 (up to 3 decimals)')
          : tNow('"{name}" is sold by the piece: enter a whole number', { name: line.product.name.trim() }),
      );
      if (input.current) input.current.value = trimQty(line.qty);
    }
  };

  return (
    <span className="qty">
      <button type="button" aria-label={t('One less {name}', { name: line.product.name })} onClick={() => step(line.key, -1)}>
        −
      </button>
      <input
        ref={input}
        key={line.qty}
        defaultValue={trimQty(line.qty)}
        inputMode="decimal"
        aria-label={t('Quantity of {name}', { name: line.product.name })}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button type="button" aria-label={t('One more {name}', { name: line.product.name })} onClick={() => step(line.key, 1)}>
        +
      </button>
    </span>
  );
}

type Props = {
  lines: CartLine[];
  totals: CartTotals;
  rate: number;
  lastKey: string | null;
  focusKey: string | null;
  /** Who approved the discount, when a manager had to. */
  approvedBy: string | null;
  onClear: () => void;
  onHold: () => void;
  onPay: () => void;
  onDiscount: () => void;
  onRemoveDiscount: () => void;
  onPrice: (key: string) => void;
};

export function CartPanel({
  lines,
  totals,
  rate,
  lastKey,
  focusKey,
  approvedBy,
  onClear,
  onHold,
  onPay,
  onDiscount,
  onRemoveDiscount,
  onPrice,
}: Props) {
  const t = useT();
  const remove = useCart((s) => s.remove);
  const empty = lines.length === 0;
  const priced = new Map(totals.lines.map((l) => [l.key, l]));

  return (
    <>
      <section className="card cart" aria-label={t('Cart')}>
        {empty ? (
          <div className="empty">
            <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{t('Cart is empty')}</div>
            <div>{t('Scan an item or search by name')}</div>
          </div>
        ) : (
          <ul className="cart-list">
            {lines.map((l) => {
              const p = priced.get(l.key);
              return (
                <li key={l.key} className={`cart-row ${l.key === lastKey ? 'current' : ''}`} data-testid="cart-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{l.product.name.trim()}</div>
                    <div className="sub">
                      {p ? fmtLbp(p.unitPriceLbp) : ''}
                      {l.product.fractional ? ` ${t('per {unit}', { unit: l.product.unitName ?? t('unit') })}` : ''}
                      {l.price && (
                        <span
                          className="muted"
                          data-testid="price-note"
                        >{` · ${l.price.approvedBy ? t('price changed, approved by {name}', { name: l.price.approvedBy }) : t('price changed')}`}</span>
                      )}{' '}
                      <button
                        type="button"
                        className="btn ghost small"
                        aria-label={t('Change the price of {name}', { name: l.product.name.trim() })}
                        onClick={() => onPrice(l.key)}
                      >
                        {t('Price')}
                      </button>
                    </div>
                  </div>
                  <QtyBox line={l} autoFocus={focusKey === l.key} />
                  <div className="num" style={{ minWidth: 96, fontWeight: 700 }}>
                    {p ? fmtLbp(p.lineTotalLbp) : ''}
                  </div>
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={t('Remove {name}', { name: l.product.name })}
                    onClick={() => remove(l.key)}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="totals">
          <div className="row">
            <span>
              {t('Subtotal')}{' '}
              {!empty && totals.discountLbp === 0 && (
                <button type="button" className="btn ghost small" onClick={onDiscount}>
                  <Icon name="discount" size={16} />
                  {t('Discount (F6)')}
                </button>
              )}
            </span>
            <span className="num">{fmtLbp(totals.subtotalLbp)}</span>
          </div>
          {totals.discountLbp > 0 && (
            <div className="row" data-testid="discount-row">
              <span>
                <button type="button" className="btn ghost small" aria-label={t('Change the discount')} onClick={onDiscount}>
                  {t('Discount')}
                </button>
                {approvedBy && <span className="muted">{` · ${t('approved by {name}', { name: approvedBy })}`}</span>}{' '}
                <button type="button" className="btn ghost small" aria-label={t('Remove the discount')} onClick={onRemoveDiscount}>
                  <Icon name="close" size={16} />
                </button>
              </span>
              <span className="num">{`−${fmtLbp(totals.discountLbp)}`}</span>
            </div>
          )}
          {totals.roundingLbp !== 0 && (
            <div className="row">
              <span>{t('Rounding')}</span>
              <span className="num">{`${totals.roundingLbp > 0 ? '+' : ''}${fmtLbp(totals.roundingLbp)}`}</span>
            </div>
          )}
        </div>
      </section>

      <div className="grand">
        <span>
          {t('TOTAL')} <span className="usd">{`≈ ${lbpAsUsd(totals.totalLbp, rate)}`}</span>
        </span>
        <span className="amount" data-testid="cart-total">
          {fmtLbp(totals.totalLbp)}
        </span>
      </div>

      <div className="actions">
        <button className="btn big" onClick={onClear} disabled={empty}>
          <Icon name="trash" size={22} />
          {t('Clear')}
        </button>
        <button className="btn big" onClick={onHold} disabled={empty}>
          <Icon name="hold" size={22} />
          {t('Hold (F4)')}
        </button>
        <button className="btn big primary" onClick={onPay} disabled={empty}>
          <Icon name="pay" size={24} />
          {t('PAY (F9)')}
        </button>
      </div>
    </>
  );
}
