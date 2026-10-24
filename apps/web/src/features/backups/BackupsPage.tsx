import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import type { BackupDetail, BackupFile } from '../../lib/types';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

const when = (iso: string) => `${iso.slice(0, 10)} ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
const mb = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

/** After a restore the server stops and starts again by itself: wait until it answers, then load the app afresh. */
async function waitForServer() {
  const up = async () => {
    try {
      return (await fetch('/api/v1/healthz', { cache: 'no-store' })).ok;
    } catch {
      return false;
    }
  };
  await new Promise((r) => setTimeout(r, 2500)); // let it go down first
  for (let i = 0; i < 90; i++) {
    if (await up()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  window.location.assign('/');
}

/** The safety copies of the shop's data: when the last one was made, whether it worked, and a button to make one now. */
export function BackupsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<BackupFile | null>(null);
  const [sure, setSure] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => get<BackupDetail>('/backups') });
  const b = backups.data;

  async function backUpNow() {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ file: string; copyError: string | null }>('/backups');
      toast.success(`Backup made: ${r.file}`);
      if (r.copyError) toast.warning(`The second copy failed: ${r.copyError}`, 8000);
      await Promise.all(['backups', 'backup-status'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The backup could not be made');
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: BackupFile) {
    setBusy(true);
    setError('');
    try {
      await post('/backups/restore', { file: file.file, confirm: true });
      setRestoring(null);
      setRestarting(true);
      void waitForServer();
    } catch (err) {
      setRestoring(null);
      setError(err instanceof ApiError ? err.message : 'The backup could not be restored. Nothing was changed.');
      setBusy(false);
    }
  }

  if (restarting)
    return (
      <main className="page" role="status">
        <h1>Restoring…</h1>
        <p>The backup is being put in place and the server is starting again. This takes a few seconds. This page reloads by itself.</p>
      </main>
    );

  if (!b) return <main className="page muted">{backups.isError ? 'The backups could not be loaded.' : 'Loading…'}</main>;

  return (
    <main className="page">
      <h1>
        <Icon name="backups" size={26} />
        Backups
      </h1>
      {!b.configured ? (
        <div className="banner warn" role="alert">
          <div className="title">Backups are not set up</div>
          <div>
            If this PC fails, the shop’s data is gone. Set <code>BACKUP_DIR</code> (and <code>BACKUP_COPY_DIR</code> for an external drive)
            in the service settings, then restart the service. The steps are in <code>docs/07-operations.md</code>.
          </div>
        </div>
      ) : (
        <>
          <div className={`banner ${b.stale ? 'warn' : 'ok'}`} data-testid="backup-banner">
            <div className="title">
              {b.lastBackupAt ? (b.stale ? 'The last backup is too old' : 'Backups are working') : 'No backup has been made yet'}
            </div>
            {b.lastBackupAt && (
              <div data-testid="backup-latest">{`Latest: ${when(b.lastBackupAt)}${b.files[0] ? ` · ${mb(b.files[0].bytes)}` : ''}`}</div>
            )}
            {b.lastRun && !b.lastRun.ok && <div role="alert">{`The last attempt failed: ${b.lastRun.error}`}</div>}
            <div className="muted">
              {`Every day from ${b.at}, keeping the newest ${b.keep}. ${b.encrypted ? 'Encrypted.' : 'NOT encrypted: anyone with the file can read it.'} ${
                b.hasSecondCopy
                  ? 'A second copy goes to another place.'
                  : 'There is no second copy: a backup on the same disk does not survive the disk failing.'
              }`}
            </div>
          </div>
          <p>
            <button className="btn primary" disabled={busy} onClick={() => void backUpNow()}>
              Back up now
            </button>
          </p>
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          {b.files.length === 0 ? (
            <div className="card empty">No backup files yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Made</th>
                  <th className="num">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {b.files.map((f) => (
                  <tr key={f.file} data-testid="backup-file">
                    <td>{f.file}</td>
                    <td className="muted">{when(f.modifiedAt)}</td>
                    <td className="num">{mb(f.bytes)}</td>
                    <td className="num">
                      <button
                        className="btn small"
                        disabled={busy}
                        aria-label={`Restore ${f.file}`}
                        onClick={() => {
                          setSure(false);
                          setRestoring(f);
                        }}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {restoring && (
        <Modal label="Restore a backup" onClose={() => setRestoring(null)}>
          <h2>Restore this backup?</h2>
          <p>
            <strong>{restoring.file}</strong>
            <br />
            <span className="muted">{`Made ${when(restoring.modifiedAt)} · ${mb(restoring.bytes)}`}</span>
          </p>
          <div className="banner warn">
            <div className="title">Everything done after this backup will be gone</div>
            <div>
              Sales, payments, stock changes and every other change made since then are replaced by what the backup holds. The data as it is
              now is backed up first and the old database file is kept, so it can be brought back by hand. The server restarts and everyone
              is signed out.
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I understand and want to restore this
            backup
          </label>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setRestoring(null)}>
              Cancel
            </button>
            <button className="btn danger" disabled={!sure || busy} onClick={() => void restore(restoring)}>
              Restore
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
