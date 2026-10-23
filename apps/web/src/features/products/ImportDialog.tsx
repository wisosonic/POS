import { useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, post } from '../../lib/api';
import { downloadCsv } from '../../lib/csv';
import { toast } from '../../store/toast';

type Row = {
  row: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  name: string;
  barcode: string;
  changes: string[];
  errors: string[];
  warnings: string[];
};
type Result = {
  applied: boolean;
  summary: { create: number; update: number; unchanged: number; errors: number };
  ignoredColumns: string[];
  newLookups: { kind: string; name: string }[];
  rows: Row[];
};

const SHOWN = 200;
const TEMPLATE = [
  ['name', 'barcode', 'price', 'cost', 'currency', 'category', 'brand', 'unit', 'supplier', 'stock_alert', 'receipt_name'],
  ['Olive oil 1L', '5281234567890', '12.50', '9.75', 'USD', 'Pantry', 'Zeit', '', 'Beirut Foods', '6', ''],
  ['Pita bread', '', '25000', '15000', 'LBP', 'Bakery', '', '', '', '', ''],
];

/**
 * Products from a spreadsheet saved as CSV. The file is checked first and nothing is written until every row is fine: a
 * manager sees what would be added and changed, and which rows have a problem and why.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [createMissing, setCreateMissing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(text: string, create: boolean, dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await post<Result>('/products/import', { csv: text, dryRun, createMissing: create });
      if (dryRun) setResult(res);
      else {
        toast.success(`Imported: ${res.summary.create} new, ${res.summary.update} changed`);
        await Promise.all(['products', 'categories', 'brands', 'suppliers'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        onClose();
      }
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'The file could not be checked');
    } finally {
      setBusy(false);
    }
  }

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const text = await file.text(); // UTF-8: Arabic names stay Arabic. A leading byte-order mark is ignored by the server.
    setCsv(text);
    void run(text, createMissing, true);
  }

  const s = result?.summary;
  const problems = (s?.errors ?? 0) > 0;
  const todo = (s?.create ?? 0) + (s?.update ?? 0);
  const shown = (result?.rows ?? [])
    .filter((r) => r.action !== 'unchanged')
    .sort((a, b) => Number(b.action === 'error') - Number(a.action === 'error'));

  return (
    <Modal label="Import products" onClose={onClose} wide>
      <>
        <h2>Import products from a spreadsheet</h2>
        <p className="muted" style={{ margin: 0 }}>
          Save the sheet as <strong>CSV (UTF-8)</strong>. The first row names the columns: <code>name</code> (needed), <code>price</code>{' '}
          (needed for new products), <code>barcode</code>, <code>cost</code>, <code>currency</code> (LBP or USD), <code>category</code>,{' '}
          <code>brand</code>, <code>unit</code>, <code>supplier</code>, <code>stock_alert</code>, <code>receipt_name</code>. A product that
          is already here (same barcode, or same name when there is no barcode) is updated, and an empty cell leaves it as it is. Lira are
          whole numbers, dollars may have cents (12.50).
        </p>
        <div className="toolbar">
          <label className="field">
            CSV file
            <input type="file" accept=".csv,text/csv" onChange={(e) => void choose(e)} disabled={busy} />
          </label>
          <button type="button" className="btn" onClick={() => downloadCsv('products-template.csv', TEMPLATE)}>
            Download an example file
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={createMissing}
            onChange={(e) => {
              setCreateMissing(e.target.checked);
              if (csv) void run(csv, e.target.checked, true);
            }}
            style={{ width: 20, height: 20 }}
          />
          Create categories, brands and suppliers that are not there yet
        </label>

        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        {busy && <p className="muted">Checking {fileName}…</p>}

        {result && !busy && (
          <section aria-label="What the file would do" style={{ display: 'grid', gap: 10 }}>
            <div className={problems ? 'banner warn' : 'banner'} data-testid="import-summary">
              <div className="title">
                {`${result.summary.create} new · ${result.summary.update} changed · ${result.summary.unchanged} already as in the file · ${result.summary.errors} with a problem`}
              </div>
              {problems && <div>Nothing is imported until every problem is fixed. Fix the file and choose it again.</div>}
              {result.newLookups.length > 0 && (
                <div>{`New in Lists: ${result.newLookups.map((l) => `${l.name} (${l.kind})`).join(', ')}`}</div>
              )}
              {result.ignoredColumns.length > 0 && <div>{`Columns not used: ${result.ignoredColumns.join(', ')}`}</div>}
            </div>
            {shown.length > 0 && (
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th className="num">Row</th>
                      <th>Product</th>
                      <th>What happens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, SHOWN).map((r) => (
                      <tr key={r.row} data-testid="import-row" data-action={r.action}>
                        <td className="num">{r.row}</td>
                        <td>{r.name || '(no name)'}</td>
                        <td>
                          {r.action === 'error' ? (
                            <span role="alert">{r.errors.join('. ')}</span>
                          ) : (
                            <>
                              {r.action === 'create' ? 'New product' : r.changes.join('; ')}
                              {r.warnings.length > 0 && <div className="muted">{r.warnings.join('. ')}</div>}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length > SHOWN && <p className="muted">{`…and ${shown.length - SHOWN} more rows.`}</p>}
              </div>
            )}
          </section>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn primary big"
            disabled={busy || !result || problems || todo === 0}
            onClick={() => void run(csv, createMissing, false)}
          >
            {todo > 0 && !problems ? `Import ${todo} product${todo === 1 ? '' : 's'}` : 'Import'}
          </button>
        </div>
      </>
    </Modal>
  );
}
