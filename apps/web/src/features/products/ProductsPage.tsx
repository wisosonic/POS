import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get } from '../../lib/api';
import { fmtMoney, trimQty } from '../../lib/money';
import type { ProductFull } from '../../lib/types';
import { ProductImage } from '../../components/ProductImage';
import { ImportDialog } from './ImportDialog';
import { ProductDialog } from './ProductDialog';
import { StockDialog } from './StockDialog';
import { useLookup } from './lookups';
import { Icon } from '../../components/Icon';

type Page = { data: ProductFull[]; nextCursor: number | null };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Every product: find one, add one, change a price or a barcode, hide one that is no longer sold. */
export function ProductsPage() {
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  // The Lists page links here with a category or a brand already chosen (/products?brandId=3).
  const [params] = useSearchParams();
  const [categoryId, setCategoryId] = useState(() => params.get('categoryId') ?? '');
  const [brandId, setBrandId] = useState(() => params.get('brandId') ?? '');
  const categories = useLookup('categories');
  const brands = useLookup('brands');
  const [editing, setEditing] = useState<ProductFull | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<ProductFull | null>(null);
  const [importing, setImporting] = useState(false);
  const search = useDebounced(q.trim(), 250);

  const products = useInfiniteQuery({
    queryKey: ['products', search, showHidden, categoryId, brandId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      get<Page>(
        `/products?limit=50&active=${showHidden ? 'all' : 'true'}&q=${encodeURIComponent(search)}${categoryId ? `&categoryId=${categoryId}` : ''}${brandId ? `&brandId=${brandId}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = products.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <main className="page">
      <h1>
        <Icon name="products" size={26} />
        Products
      </h1>
      <div className="toolbar">
        <label className="field">
          Search
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or barcode" autoFocus />
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name.trim()}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          Brand
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">All brands</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name.trim()}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} style={{ width: 20, height: 20 }} />
          Show hidden products
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>
          <Icon name="upload" size={18} />
          Import CSV…
        </button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          New product
        </button>
      </div>

      {products.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">{categoryId || brandId ? 'No products match these filters.' : 'No products found.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th aria-label="Picture" />
              <th>Product</th>
              <th>Barcode</th>
              <th className="num">Price</th>
              <th className="num">Cost</th>
              <th className="num">In stock</th>
              <th className="num">Low at</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const low = p.stockAlert !== null && Number(p.qty) <= p.stockAlert;
              return (
                <tr key={p.id} data-testid="product-row" className={p.active ? '' : 'muted'}>
                  <td style={{ width: 56 }}>
                    <ProductImage product={p} />
                  </td>
                  <td>
                    {p.name.trim()}
                    {!p.active && <span className="chip">Hidden</span>}
                  </td>
                  <td className="muted">{p.barcode}</td>
                  <td className="num">{fmtMoney(p.priceMinor, p.currency)}</td>
                  <td className="num">{fmtMoney(p.costMinor, p.currency)}</td>
                  <td
                    className={`num ${low ? 'variance-bad' : ''}`}
                  >{`${trimQty(p.qty)}${p.unitName && p.fractional ? ` ${p.unitName}` : ''}`}</td>
                  <td className="num muted" data-testid="low-at">
                    {p.stockAlert === null ? '' : trimQty(String(p.stockAlert))}
                  </td>
                  <td className="num">
                    <button className="btn small" onClick={() => setAdjusting(p)} aria-label={`Stock of ${p.name.trim()}`}>
                      <Icon name="stock" size={16} />
                      Stock
                    </button>{' '}
                    <button className="btn small" onClick={() => setEditing(p)} aria-label={`Edit ${p.name.trim()}`}>
                      <Icon name="edit" size={16} />
                      Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {products.hasNextPage && (
        <p>
          <button className="btn" disabled={products.isFetchingNextPage} onClick={() => void products.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
      {editing && <ProductDialog product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {adjusting && <StockDialog product={adjusting} onClose={() => setAdjusting(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </main>
  );
}
