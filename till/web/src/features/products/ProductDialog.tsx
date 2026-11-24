import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ProductImage } from '../../components/ProductImage';
import { ApiError, api, patch, post } from '../../lib/api';
import { parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, ProductFull } from '../../lib/types';
import { toast } from '../../store/toast';
import { minorToInput, useLookup, useSuppliers, useUnits } from './lookups';

// The server refuses anything else or anything bigger; checking here says so before the file is sent.
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
const PICTURE_EXT = /\.(jpe?g|jfif|png|gif|webp|avif)$/i;

/** Why this file cannot be a product picture, or null if it looks fine. (The server looks at the bytes and has the last word.) */
export function pictureProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size > MAX_PICTURE_BYTES) return `That picture is ${(file.size / 1_048_576).toFixed(1)} MB. Choose one under 5 MB.`;
  if (!PICTURE_TYPES.includes(file.type) && !PICTURE_EXT.test(file.name))
    return 'That is not a picture the shop can use. Choose a JPEG, PNG, GIF, WebP or AVIF file.';
  return null;
}

const parseMoney = (text: string, currency: Currency) => (currency === 'USD' ? parseUsdInput(text) : parseLbpInput(text));
const idOrNull = (v: string) => (v === '' ? null : Number(v));

/** Add a product, or edit one. Each product has its own currency; the price typed here is in that currency. */
export function ProductDialog({ product, onClose }: { product: ProductFull | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const categories = useLookup('categories');
  const brands = useLookup('brands');
  const units = useUnits();
  const suppliers = useSuppliers();

  const [name, setName] = useState(product?.name ?? '');
  const [receiptName, setReceiptName] = useState(product?.receiptNameManual ? (product.receiptName ?? '') : '');
  const [barcode, setBarcode] = useState(product?.barcode ?? '');
  const [currency, setCurrency] = useState<Currency>(product?.currency ?? 'LBP');
  const [price, setPrice] = useState(product ? minorToInput(product.priceMinor, product.currency) : '');
  const [cost, setCost] = useState(product ? minorToInput(product.costMinor, product.currency) : '');
  const [unitId, setUnitId] = useState(String(product?.unitId ?? ''));
  const [categoryId, setCategoryId] = useState(String(product?.categoryId ?? ''));
  const [brandId, setBrandId] = useState(String(product?.brandId ?? ''));
  const [supplierId, setSupplierId] = useState(String(product?.supplierId ?? ''));
  // No alert is its own choice (a tick box), not an empty number: a threshold of 0 is a real one, "tell me when none are left".
  const [noAlert, setNoAlert] = useState(!product || product.stockAlert === null);
  const [alert, setAlert] = useState(product && product.stockAlert !== null ? String(product.stockAlert) : '');
  const [active, setActive] = useState(product?.active ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The picture: a newly chosen file waits here until Save, so cancelling the form changes nothing.
  const [picture, setPicture] = useState<File | null>(null);
  const [removePicture, setRemovePicture] = useState(false);
  const [pictureError, setPictureError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!picture) return setPreview(null);
    const url = URL.createObjectURL(picture);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picture]);
  const shownPicture = preview ?? (removePicture ? null : (product?.imagePath ?? null));

  function choosePicture(file: File | undefined) {
    if (!file) return;
    const problem = pictureProblem(file);
    setPictureError(problem ?? '');
    if (problem) return;
    setPicture(file);
    setRemovePicture(false);
  }

  // Changing the currency re-reads what is typed in the other one, so "4.50" never silently becomes 450 lira.
  function changeCurrency(next: Currency) {
    if (next === currency) return;
    const convert = (text: string) => {
      const v = parseMoney(text, currency);
      return Number.isFinite(v) && text.trim() !== '' ? minorToInput(v, next) : text;
    };
    setPrice(convert(price));
    setCost(convert(cost));
    setCurrency(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const priceMinor = parseMoney(price, currency);
    const costMinor = parseMoney(cost, currency);
    if (!name.trim()) return setError('Enter the product name');
    if (!Number.isFinite(priceMinor) || price.trim() === '') return setError('Enter the selling price');
    if (!Number.isFinite(costMinor)) return setError('The cost is not a valid amount');
    const alertValue = noAlert ? null : alert.trim() === '' ? NaN : Number(alert.replace(',', '.'));
    if (alertValue !== null && !(alertValue >= 0)) return setError('Type the low stock threshold (0 or more), or tick No alert');

    const body = {
      name: name.trim(),
      receiptName: receiptName.trim() || null,
      barcode: barcode.trim(),
      currency,
      priceMinor,
      costMinor,
      unitId: idOrNull(unitId),
      categoryId: idOrNull(categoryId),
      brandId: idOrNull(brandId),
      supplierId: idOrNull(supplierId),
      stockAlert: alertValue,
    };
    setBusy(true);
    setError('');
    try {
      let id: number;
      if (product) {
        await patch(`/products/${product.id}`, { ...body, active });
        id = product.id;
        toast.success(`Saved ${body.name}`);
      } else {
        const created = await post<{ id: number; warnings?: string[] }>('/products', body);
        id = created.id;
        toast.success(`Added ${body.name}`);
        if (created.warnings?.includes('DUPLICATE_BARCODE')) toast.warning('Another product already has this barcode', 6000);
      }
      // The product is saved by now. A picture that cannot be added must not lose it: say what happened and carry on.
      try {
        if (picture) await api('POST', `/products/${id}/image`, picture);
        else if (removePicture && product?.imagePath) await api('DELETE', `/products/${id}/image`);
      } catch (err) {
        toast.warning(
          `The product was saved, but its picture was not: ${err instanceof ApiError ? err.message : 'the picture could not be sent'}`,
          8000,
        );
      }
      // a changed low stock threshold changes the badge and the Low stock list too
      await Promise.all(['products', 'alerts'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The product could not be saved');
      setBusy(false);
    }
  }

  const options = (rows: { id: number; name: string }[] | undefined, none: string) => (
    <>
      <option value="">{none}</option>
      {(rows ?? []).map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </>
  );

  return (
    <Modal label={product ? 'Edit product' : 'New product'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{product ? 'Edit product' : 'New product'}</h2>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
        </label>
        <label className="field">
          Barcode
          <input value={barcode} onChange={(e) => setBarcode(e.target.value)} autoComplete="off" inputMode="numeric" />
          <span className="hint">Scan it into this box. Leave empty for loose items you search by name.</span>
        </label>
        <div className="method">
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => changeCurrency(e.target.value as Currency)}>
              <option value="LBP">LBP (lira)</option>
              <option value="USD">USD (dollars)</option>
            </select>
          </label>
          <label className="field">
            {`Selling price (${currency})`}
            <input className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            {`Cost (${currency})`}
            <input className="num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Unit
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              {options(units.data, 'No unit')}
            </select>
          </label>
        </div>
        <div className="method">
          <label className="field">
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {options(categories.data, 'None')}
            </select>
          </label>
          <label className="field">
            Brand
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              {options(brands.data, 'None')}
            </select>
          </label>
          <label className="field">
            Supplier
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {options(suppliers.data, 'None')}
            </select>
          </label>
          <div style={{ display: 'grid', gap: 6 }}>
            <label className="field">
              Low stock threshold
              <input
                className="num"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={alert}
                disabled={noAlert}
                onChange={(e) => setAlert(e.target.value)}
              />
              <span className="hint">
                The owner is told when the quantity falls to this number or below. 0 means: when there are none left.
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={noAlert} onChange={(e) => setNoAlert(e.target.checked)} />
              No alert for this product
            </label>
          </div>
        </div>
        <div className="field">
          <span>Picture</span>
          <div className="picture-row">
            {shownPicture ? (
              <img className="thumb" src={shownPicture} alt={`Picture of ${name.trim() || 'the product'}`} width={96} height={96} />
            ) : (
              <ProductImage product={{ name: name || '?' }} size={96} />
            )}
            <label className="btn" style={{ cursor: 'pointer' }}>
              {shownPicture ? 'Choose another picture' : 'Choose a picture'}
              <input
                type="file"
                accept={PICTURE_TYPES.join(',')}
                aria-label="Product picture file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  choosePicture(e.target.files?.[0]);
                  e.target.value = ''; // choosing the same file again must still count
                }}
              />
            </label>
            {shownPicture && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setPicture(null);
                  setRemovePicture(true);
                  setPictureError('');
                }}
              >
                Remove picture
              </button>
            )}
          </div>
          <span className="hint">JPEG, PNG, GIF, WebP or AVIF, up to 5 MB. It is shown in the product list and on the till.</span>
          {pictureError && (
            <span className="warning" role="alert">
              {pictureError}
            </span>
          )}
        </div>
        <label className="field">
          Name on the receipt
          <input value={receiptName} onChange={(e) => setReceiptName(e.target.value)} placeholder="Automatic (Arabic is transliterated)" />
          <span className="hint">The receipt printer only prints English letters. Fill this only to override the automatic name.</span>
        </label>
        {product && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: 20, height: 20 }} />
            Sold in the shop (untick to hide it from the till)
          </label>
        )}
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
