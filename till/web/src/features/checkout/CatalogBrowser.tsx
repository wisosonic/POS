import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ProductImage } from '../../components/ProductImage';
import { categoryIcon } from '../../lib/categoryIcon';
import { groupByCategory } from '../../lib/catalogGroups';
import { fmtLbp, unitPriceLbp } from '../../lib/money';
import type { Product } from '../../lib/types';

/**
 * The whole catalog for browsing. First a grid of squares, one per category (an icon, the name and how many products); pressing
 * one shows that category's products with a link back to all categories.
 */
export function CatalogBrowser({
  products,
  categories,
  rate,
  onPick,
}: {
  products: Product[];
  categories: { id: number; name: string }[];
  rate: number | undefined;
  onPick: (p: Product) => void;
}) {
  const groups = useMemo(() => groupByCategory(products, categories), [products, categories]);
  const [selected, setSelected] = useState<string | null>(null);
  const group = groups.find((g) => g.key === selected) ?? null;
  const back = useRef<HTMLButtonElement>(null);
  const tiles = useRef<Record<string, HTMLButtonElement | null>>({});
  const was = useRef<string | null>(null);

  // Keyboard users: moving into a category puts focus on the way back, and going back returns to the tile they came from.
  useEffect(() => {
    if (selected) back.current?.focus();
    else if (was.current) tiles.current[was.current]?.focus();
    was.current = selected;
  }, [selected]);

  if (group) {
    return (
      <section className="catalog" aria-label="Product catalog">
        <div className="catalog-bar">
          <button ref={back} type="button" className="btn small" onClick={() => setSelected(null)}>
            <Icon name="back" size={18} />
            All categories
          </button>
          <h3 className="catalog-title">{group.name}</h3>
          <span className="muted">{`${group.products.length} ${group.products.length === 1 ? 'product' : 'products'}`}</span>
        </div>
        <ul className="results catalog-list" aria-label={group.name}>
          {group.products.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p)}>
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
      </section>
    );
  }

  return (
    <section className="catalog" aria-label="Product catalog">
      <div className="catalog-bar">
        <span
          className="muted"
          data-testid="catalog-summary"
        >{`${products.length} products in ${groups.length} ${groups.length === 1 ? 'category' : 'categories'}`}</span>
      </div>
      {groups.length === 0 && <div className="card empty">The catalog is empty.</div>}
      <div className="category-grid">
        {groups.map((g) => (
          <button
            key={g.key}
            ref={(el) => {
              tiles.current[g.key] = el;
            }}
            type="button"
            className="category-tile"
            data-testid="category-tile"
            onClick={() => setSelected(g.key)}
          >
            <Icon name={categoryIcon(g.name, g.categoryId !== null)} size={36} />
            <span className="catalog-name">{g.name}</span>
            <span className="count">{`${g.products.length} ${g.products.length === 1 ? 'product' : 'products'}`}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
