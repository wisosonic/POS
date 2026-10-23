import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, patch, post } from '../../lib/api';
import { parseLbpInput } from '../../lib/money';
import type { FullSettings } from '../../lib/types';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** The shop's own details, how receipts look, and the printer. Only the admin sees this. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: ['settings-full'], queryFn: () => get<FullSettings>('/settings') });
  const s = saved.data;

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [footer, setFooter] = useState('');
  const [width, setWidth] = useState('');
  const [printer, setPrinter] = useState('');
  const [rounding, setRounding] = useState('');
  const [discount, setDiscount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openDrawer, setOpenDrawer] = useState(false);
  const [testing, setTesting] = useState(false);

  // Fill the boxes once, when the settings arrive (and again after a save, so they show what is stored).
  useEffect(() => {
    if (!s) return;
    setName(s.name);
    setAddress(s.address ?? '');
    setPhone(s.phone ?? '');
    setEmail(s.email ?? '');
    setFooter(s.receiptFooter);
    setWidth(String(s.receiptWidth));
    setPrinter(s.printerName ?? '');
    setRounding(String(s.lbpRounding));
    setDiscount(String(s.cashierDiscountLimitPct));
  }, [s]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const widthN = Number(width);
    const roundingN = parseLbpInput(rounding);
    const discountN = Number(discount);
    if (!name.trim()) return setError('The shop needs a name');
    if (!Number.isInteger(widthN) || widthN < 20 || widthN > 80)
      return setError('The receipt width is a number of characters between 20 and 80 (42 for an 80 mm printer)');
    if (!(roundingN >= 1)) return setError('Round totals to a whole number of at least 1 (5,000 rounds to the nearest 5,000 LL)');
    if (!Number.isInteger(discountN) || discountN < 0 || discountN > 100)
      return setError('The discount limit is a percentage from 0 to 100');
    setBusy(true);
    setError('');
    try {
      await patch('/settings', {
        name: name.trim(),
        address: blankToNull(address),
        phone: blankToNull(phone),
        email: blankToNull(email),
        receiptFooter: footer.trim(),
        receiptWidth: widthN,
        printerName: blankToNull(printer),
        lbpRounding: roundingN,
        cashierDiscountLimitPct: discountN,
      });
      toast.success('Settings saved');
      await Promise.all(['settings-full', 'settings'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The settings could not be saved');
    } finally {
      setBusy(false);
    }
  }

  async function testPrint() {
    setTesting(true);
    setError('');
    try {
      await post('/settings/printer-test', { openDrawer });
      toast.success('Test slip sent to the printer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The test slip could not be printed');
    } finally {
      setTesting(false);
    }
  }

  if (!s) return <main className="page muted">{saved.isError ? 'The settings could not be loaded.' : 'Loading…'}</main>;
  // The test slip goes to the SAVED printer, so say so when the box has been changed.
  const printerChanged = printer.trim() !== (s.printerName ?? '') || width.trim() !== String(s.receiptWidth);

  return (
    <main className="page">
      <h1>
        <Icon name="settings" size={26} />
        Settings
      </h1>
      <form onSubmit={save} style={{ display: 'grid', gap: 18, maxWidth: 720 }}>
        <section className="card" style={{ display: 'grid', gap: 12, padding: 16 }}>
          <h2 style={{ margin: 0 }}>The shop</h2>
          <label className="field">
            Name (printed at the top of every receipt)
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Address
            <input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" />
          </label>
          <div className="method">
            <label className="field">
              Phone
              <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </label>
          </div>
        </section>

        <section className="card" style={{ display: 'grid', gap: 12, padding: 16 }}>
          <h2 style={{ margin: 0 }}>Receipt and printer</h2>
          <label className="field">
            Printer name
            <input
              value={printer}
              onChange={(e) => setPrinter(e.target.value)}
              placeholder="Exactly as Windows lists it, for example POS-80"
              autoComplete="off"
            />
            <span className="hint">
              Empty means receipts open in the browser's print window instead. The printer must be installed in Windows for all users.
            </span>
          </label>
          <div className="method">
            <label className="field">
              Receipt width (characters)
              <input className="num" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
              <span className="hint">42 for an 80 mm printer, 32 for 58 mm.</span>
            </label>
            <label className="field">
              Line at the bottom of the receipt
              <input value={footer} onChange={(e) => setFooter(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button type="button" className="btn" disabled={testing || printerChanged || !s.printerName} onClick={() => void testPrint()}>
              Print a test slip
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={openDrawer}
                onChange={(e) => setOpenDrawer(e.target.checked)}
                style={{ width: 20, height: 20 }}
              />
              Also open the cash drawer
            </label>
          </div>
          {printerChanged && <span className="hint">Save first: the test slip goes to the saved printer and width.</span>}
          <span className="hint">The slip has a ruler as wide as the receipt and an Arabic name, so you can check both.</span>
        </section>

        <section className="card" style={{ display: 'grid', gap: 12, padding: 16 }}>
          <h2 style={{ margin: 0 }}>Prices and cashiers</h2>
          <div className="method">
            <label className="field">
              Round totals to (LL)
              <input className="num" inputMode="numeric" value={rounding} onChange={(e) => setRounding(e.target.value)} />
              <span className="hint">5,000 rounds every total to the nearest 5,000 LL.</span>
            </label>
            <label className="field">
              Largest discount a cashier may give (%)
              <input className="num" inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </label>
          </div>
        </section>

        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div>
          <button type="submit" className="btn primary big" disabled={busy}>
            Save settings
          </button>
        </div>
      </form>
    </main>
  );
}
