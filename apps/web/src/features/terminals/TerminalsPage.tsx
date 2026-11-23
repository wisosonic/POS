import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { isNotATill, useTerminal } from '../../hooks/useTillData';
import { ApiError, get, patch, post } from '../../lib/api';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';
import { EnrolForm } from './EnrolForm';

type TerminalRow = {
  id: number;
  code: string;
  name: string;
  branch: { id: number; code: string; name: string };
  active: boolean;
  enrolled: boolean;
  enrolPending: boolean;
  openSessionId: number | null;
};

type ShownCode = { name: string; code: string; expiresAt: string };

/**
 * The tills of this branch. Each till (a browser on a PC or tablet) has its own register. To add one: give it a name here, take the
 * code this page shows, open the till on that computer, sign in as the admin and type the code (Settings → Tills there).
 */
export function TerminalsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useTerminal();
  const list = useQuery({ queryKey: ['terminals'], queryFn: () => get<{ data: TerminalRow[] }>('/terminals').then((r) => r.data) });
  const rows = list.data ?? [];
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['terminals'] });

  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : t('That did not work. Try again.'));

  async function newCode(row: TerminalRow) {
    setBusyId(row.id);
    try {
      const r = await post<{ enrolCode: string; expiresAt: string }>(`/terminals/${row.id}/enrol-code`);
      setShown({ name: row.name, code: r.enrolCode, expiresAt: r.expiresAt });
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  async function setActive(row: TerminalRow, active: boolean) {
    setBusyId(row.id);
    try {
      await patch(`/terminals/${row.id}`, { active });
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(row: TerminalRow) {
    if (!window.confirm(t('{name} will stop working until it is set up again. Continue?', { name: row.name }))) return;
    setBusyId(row.id);
    try {
      await post(`/terminals/${row.id}/revoke`);
      toast.success(t('{name} was disconnected', { name: row.name }));
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  const deviceUnknown = isNotATill(me.error);

  return (
    <main className="page">
      <h1>
        <Icon name="till" size={26} />
        {t('Tills')}
      </h1>

      <section className={`banner ${me.data ? 'ok' : 'warn'}`} style={{ marginBottom: 16 }} data-testid="this-device">
        <div className="title">{t('This computer')}</div>
        {me.isLoading ? (
          <span className="muted">{t('Loading…')}</span>
        ) : me.data ? (
          <span>{t('This computer is {name} ({code}).', { name: me.data.name, code: me.data.code })}</span>
        ) : deviceUnknown ? (
          <>
            <span>{t('This computer is not set up as a till. Type the code of the till it should be.')}</span>
            <EnrolForm />
          </>
        ) : (
          <>
            <span>{t('The server could not say which till this is.')}</span>
          </>
        )}
      </section>

      <div className="toolbar">
        <p className="muted" style={{ margin: 0 }}>
          {t('Set up the till you are using now first, then add the others. Each till has its own register and cash drawer.')}
        </p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} />
          {t('Add a till')}
        </button>
      </div>

      {list.isLoading ? (
        <p className="muted">{t('Loading…')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('Name')}</th>
              <th>{t('Code')}</th>
              <th>{t('Status')}</th>
              <th>{t('Register')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="terminal-row" style={r.active ? undefined : { opacity: 0.6 }}>
                <td>
                  {r.name}
                  {me.data?.id === r.id && <span className="muted"> {t('(this computer)')}</span>}
                </td>
                <td dir="ltr">{r.code}</td>
                <td>
                  {!r.active ? t('Switched off') : r.enrolled ? t('Set up') : r.enrolPending ? t('Waiting for its code') : t('Not set up')}
                </td>
                <td>{r.openSessionId ? t('Open (#{n})', { n: r.openSessionId }) : t('Closed')}</td>
                <td className="num">
                  <div className="actions">
                    {r.active && (
                      <button className="btn small" disabled={busyId === r.id} onClick={() => void newCode(r)}>
                        {t('New code')}
                      </button>
                    )}
                    {r.enrolled && (
                      <button className="btn small" disabled={busyId === r.id} onClick={() => void revoke(r)}>
                        {t('Disconnect')}
                      </button>
                    )}
                    <button className="btn small" disabled={busyId === r.id} onClick={() => void setActive(r, !r.active)}>
                      {r.active ? t('Switch off') : t('Switch on')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={async (name, code, expiresAt) => {
            setAdding(false);
            setShown({ name, code, expiresAt });
            await refresh();
          }}
        />
      )}
      {shown && <CodeDialog shown={shown} onClose={() => setShown(null)} />}
    </main>
  );
}

function AddDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (name: string, code: string, expiresAt: string) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError(t('Type a name for the till'));
    setBusy(true);
    setError('');
    try {
      const r = await post<{ terminal: { name: string }; enrolCode: string; expiresAt: string }>('/terminals', { name: name.trim() });
      await onAdded(r.terminal.name, r.enrolCode, r.expiresAt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('That did not work. Try again.'));
      setBusy(false);
    }
  }

  return (
    <Modal label={t('Add a till')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{t('Add a till')}</h2>
        <label className="field">
          {t('Name (for example Till 2, or Back counter)')}
          <input autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The one-time code, shown once and never kept. It works for half an hour and only once. */
function CodeDialog({ shown, onClose }: { shown: ShownCode; onClose: () => void }) {
  const t = useT();
  const minutes = Math.max(1, Math.round((Date.parse(shown.expiresAt) - Date.now()) / 60_000));
  return (
    <Modal label={t('Code for {name}', { name: shown.name })} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <h2>{t('Code for {name}', { name: shown.name })}</h2>
        <p style={{ margin: 0 }}>
          {t('On the computer that will be this till, sign in as the admin, open Settings → Tills and type this code:')}
        </p>
        <div className="banner ok" style={{ textAlign: 'center' }}>
          <span style={{ fontSize: '2rem', fontWeight: 800, letterSpacing: 2 }} dir="ltr" data-testid="enrol-code-shown">
            {shown.code}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t('It works once, for the next {n} minutes. It is not shown again.', { n: minutes })}
        </p>
        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            {t('Done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
