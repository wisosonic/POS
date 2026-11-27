import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { get } from '../lib/api';
import { getTerminalToken } from '../lib/terminal';
import { watchTopics, type PingAnswer, type Topic } from '../lib/topics';
import { useUi } from '../store/ui';

/**
 * Keep the screens current (docs/14 §3): ask the branch server's ping every few seconds and refresh only the topics whose number moved.
 * A changed catalog is synced (after a short pause, so a burst of edits is fetched once); stock refreshes the low-stock list, and so on.
 * After a missed answer or a server restart everything is refreshed. A device that is not an enrolled till has no device token, so the
 * ping would refuse it: it simply gets no live refresh (its screens still load fresh when opened).
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

    const handle: Record<Topic, () => void> = {
      catalog: syncCatalog,
      stock: () => invalidate('alerts'),
      rate: () => invalidate('rate'),
      settings: () => invalidate('settings'),
      register: () => invalidate('register'),
      wallets: () => invalidate('wallets'), // a manager counted a wallet or moved money in or out of one
      sync: () => invalidate('sync', 'settings'), // connecting or disconnecting HQ changes who owns the catalog (the settings answer says so)
    };

    const stop = watchTopics({
      ask: async () => {
        if (!getTerminalToken()) return null;
        return get<PingAnswer>('/ping', { noRefresh: true });
      },
      onChange: (topics) => {
        topics.forEach((t) => handle[t]());
        if (topics.length === Object.keys(handle).length) invalidate('terminal'); // everything: a restart, or answers were missed
      },
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [queryClient]);
}
