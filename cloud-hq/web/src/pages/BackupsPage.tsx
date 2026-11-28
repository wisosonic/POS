import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { ago } from '../lib/format';

type Status = {
  configured: boolean;
  encrypted: boolean;
  hasSecondCopy: boolean;
  at: string;
  keep: number;
  lastBackupAt: string | null;
  stale: boolean;
  lastRun: { at: string; ok: boolean; trigger: string; file?: string; error?: string; copyError?: string } | null;
  files: { file: string; bytes: number; modifiedAt: string; encrypted: boolean }[];
};

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function BackupsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['backups'], queryFn: () => get<Status>('/backups') });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const now = useMutation({
    mutationFn: () => post<{ file: string; copyError: string | null }>('/backups'),
    onSuccess: async (r) => {
      setError('');
      setMessage(r.copyError ? `Backup made (${r.file}), but the second copy failed: ${r.copyError}` : `Backup made: ${r.file}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['backups'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ]);
    },
    onError: (e) => {
      setMessage('');
      setError(e instanceof ApiError ? e.message : 'The backup failed.');
    },
  });
  const s = status.data;

  return (
    <div className="stack">
      <h1>Backups</h1>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {message && <div className="banner ok">{message}</div>}
      {s && !s.configured && (
        <div className="banner warn">
          HQ is not making backups. Set <code>BACKUP_DIR</code> (and <code>BACKUP_COPY_DIR</code> for a second place) in HQ&rsquo;s settings
          file, then restart it.
        </div>
      )}
      {s && (
        <section className="card">
          <p>
            Last backup: <strong>{ago(s.lastBackupAt)}</strong>
            {s.stale && <span className="pill bad"> overdue</span>}
          </p>
          <p className="muted">
            Made every day from {s.at}, keeping the newest {s.keep}. {s.encrypted ? 'Encrypted.' : 'NOT encrypted: set BACKUP_PASSPHRASE.'}{' '}
            {s.hasSecondCopy ? 'Copied to a second place.' : 'No second copy: a backup on the same disk does not survive the disk failing.'}
          </p>
          {s.lastRun && !s.lastRun.ok && <p className="banner warn">The last attempt failed: {s.lastRun.error}</p>}
          <button className="btn primary" onClick={() => now.mutate()} disabled={now.isPending || !s.configured}>
            {now.isPending ? 'Backing up…' : 'Back up now'}
          </button>
          <p className="muted small">It is safe while HQ is working. To restore, stop HQ and use the restore command (docs/17).</p>
        </section>
      )}
      {s && s.files.length > 0 && (
        <section className="card">
          <h2>Backups on disk</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Made</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {s.files.map((f) => (
                  <tr key={f.file}>
                    <td>{f.file}</td>
                    <td>{new Date(f.modifiedAt).toLocaleString()}</td>
                    <td className="num">{mb(f.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
