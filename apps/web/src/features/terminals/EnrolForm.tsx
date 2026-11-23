import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../../lib/api';
import { setTerminalToken } from '../../lib/terminal';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';

type Enrolled = { token: string; terminal: { id: number; code: string; name: string } };

/**
 * Turn this browser into a till: the admin types the one-time code that Settings → Tills showed. The server answers with a
 * device token, which this browser keeps, so every request from here on says which till it is. Only an admin can do it.
 */
export function EnrolForm({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const done = await post<Enrolled>('/terminals/enrol', { code: code.trim() });
      setTerminalToken(done.token);
      setCode('');
      toast.success(t('This computer is now {name}', { name: done.terminal.name }));
      // Everything that depends on which till this is has to be asked again.
      await queryClient.invalidateQueries();
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403)
        setError(t('An admin has to be signed in on this computer to set it up as a till.'));
      else setError(err instanceof ApiError ? err.message : t('That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      <label className="field">
        {t('Enrolment code')}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXXX-XXXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          dir="ltr"
          data-testid="enrol-code"
        />
      </label>
      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
          {t('Set up this computer')}
        </button>
      </div>
    </form>
  );
}
