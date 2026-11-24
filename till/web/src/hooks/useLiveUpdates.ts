import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { openStream } from '../lib/api';
import { startEvents, type LiveEvent } from '../lib/events';
import { useUi } from '../store/ui';

/**
 * Listen for the server's live updates while the till is open, and refresh only what the event says is stale:
 * a changed catalog is synced (after a short pause, so a burst of edits is fetched once), stock changes refresh the low-stock list,
 * and so on. After a dropped connection comes back, everything is refreshed, because events may have been missed.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: number | undefined;
    const invalidate = (...keys: string[]) => keys.forEach((k) => void queryClient.invalidateQueries({ queryKey: [k] }));
    const syncCatalog = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void useUi.getState().loadCatalog(), 800);
    };

    const handle: Record<LiveEvent, () => void> = {
      'catalog.changed': syncCatalog,
      'stock.changed': () => invalidate('alerts'),
      'rate.changed': () => invalidate('rate'),
      'settings.changed': () => invalidate('settings'),
      'register.updated': () => invalidate('register'),
      'sale.completed': () => undefined, // the stock event that comes with it does the work
      'sync.changed': () => invalidate('sync'),
    };

    const stop = startEvents({
      open: (signal) => openStream('/events', signal),
      onEvent: (type) => handle[type](),
      onConnected: (again) => {
        if (!again) return; // the till has just loaded all of this itself
        syncCatalog();
        invalidate('alerts', 'rate', 'settings', 'register', 'terminal');
      },
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [queryClient]);
}
