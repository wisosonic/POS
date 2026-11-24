import { create } from 'zustand';
import { outbox } from '../lib/outbox';

// Is the server reachable, and how many sales are waiting to be sent? Drives the "Offline" and "N pending" chips and
// the automatic re-send.

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
    const c = await outbox.counts();
    set({ waiting: c.waiting, blocked: c.blocked });
  },
}));

/** Start watching the connection and re-sending queued sales. Returns a function that stops it. */
export function startConnectionWatch(onSent: () => void): () => void {
  const { setOnline, refreshCounts } = useConnection.getState();

  const flush = async () => {
    const before = await outbox.counts();
    if (before.waiting === 0) return;
    const result = await outbox.flush();
    if (result.sent > 0) {
      setOnline(true);
      onSent();
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
  // Also retry on a timer: the API may simply have been restarting while the browser still thought it was online.
  const timer = window.setInterval(() => void flush(), 10_000);
  void refreshCounts().then(flush);

  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
    unsubscribe();
    window.clearInterval(timer);
  };
}
