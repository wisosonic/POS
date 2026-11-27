import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../../lib/api';
import type { Product } from '../../lib/types';
import { useT } from '../../store/lang';

/** Type part of a name or scan a barcode, then pick the product. Stock is never checked. */
export function ProductPicker({ onPick }: { onPick: (p: Product) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const text = q.trim();
  const results = useQuery({
    queryKey: ['picker', text],
    enabled: text.length >= 2,
    queryFn: () => get<{ data: Product[] }>(`/products?limit=8&q=${encodeURIComponent(text)}`).then((r) => r.data),
  });
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label className="field">
        {t('Add a product')}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Name or barcode')} autoComplete="off" />
      </label>
      {text.length >= 2 && (results.data ?? []).length > 0 && (
        <div role="listbox" aria-label={t('Matching products')} style={{ display: 'grid', gap: 4 }}>
          {(results.data ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={false}
              className="btn"
              style={{ justifyContent: 'space-between', textAlign: 'start' }}
              onClick={() => {
                onPick(r);
                setQ('');
              }}
            >
              <span>{r.name.trim()}</span>
              <span className="muted">{r.barcode}</span>
            </button>
          ))}
        </div>
      )}
      {text.length >= 2 && results.data?.length === 0 && <span className="muted">{t('No product matches.')}</span>}
    </div>
  );
}
