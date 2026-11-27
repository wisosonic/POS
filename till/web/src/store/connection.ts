import { create } from 'zustand';
import { adoptOldBrowserQueue, outbox } from '../lib/outbox';
import { useLink } from './link';

// Is the server reachable, and how many sales are in doubt (sent, not confirmed)? Drives the "Offline" and "N pending" chips, the
// stop on new sales while one is unconfirmed, and the automatic re-send of that sale with its own key.

type ConnectionState = {
  online: boolean;
  waiting: number;
  blocked: number;
  setOnline: (online: boolean) => void;
  refreshCounts: () => Promise<void>;
};

export const useConnection = create<ConnectionState>((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  waiting: 0,
  blocked: 0,
  setOnline: (online) => set({ online }),
  async refreshCounts() {
    try {
      const c = await outbox.counts();
      set({ waiting: c.waiting, blocked: c.blocked });
      // A new sale is not taken while one is unconfirmed or refused and not yet dealt with (docs/14 §4.3).
      useLink.getState().setDoubt(c.waiting + c.blocked);
    } catch {
      /* the till program did not answer for a moment: keep what is shown, the next round asks again */
    }
  },
}));

/** Start watching the connection and re-sending queued sales. Returns a function that stops it. */
export function startConnectionWatch(onSent: () => void): () => void {
  const { setOnline, refreshCounts } = useConnection.getState();

  const flush = async () => {
    try {
      const before = await outbox.counts();
      if (before.waiting === 0) return;
      const result = await outbox.flush();
      if (result.sent > 0) {
        setOnline(true);
        onSent();
      }
    } catch {
      /* the till program did not answer: tried again at the next round */
    }
    await refreshCounts();
  };

  const goOnline = () => {
    setOnline(true);
    void flush();
  };
  const goOffline = () => setOnline(false);
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  const unsubscribe = outbox.subscribe(() => void refreshCounts());
  // Also retry on a timer: the API may simply have been restarting while the browser still thought it was online. Selling is paused
  // until the unconfirmed sale is settled, so this is a short wait.
  const timer = window.setInterval(() => void flush(), 4_000);
  // Sales left in the old browser queue move into the journal first (never dropped), then everything waiting is sent.
  void adoptOldBrowserQueue()
    .catch(() => 0)
    .then(refreshCounts)
    .then(flush);

  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
    unsubscribe();
    window.clearInterval(timer);
    useLink.getState().setDoubt(0);
  };
}
