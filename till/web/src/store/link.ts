import { create } from 'zustand';
import { sellingBlock, type SellingBlock } from '../lib/link';
import { getTerminalToken } from '../lib/terminal';
import { getTillLink } from '../lib/tillServer';

// Is the branch server answering? The till's own server watches it (a heartbeat every few seconds); this asks that server, often,
// and the checkout stops selling while the answer is "no" (docs/14-connection-and-till-backend.md). The cart is kept.

type LinkStore = {
  /** Selling is stopped and why; null while it is allowed. */
  block: SellingBlock;
  set: (block: SellingBlock) => void;
};

export const useLink = create<LinkStore>((set) => ({ block: null, set: (block) => set({ block }) }));

/** Ask every `everyMs` while the page is open. Returns the function that stops it. */
export function startLinkWatch(everyMs = 2_000): () => void {
  let stopped = false;
  let timer: number | undefined;
  const ask = async () => {
    const answer = await getTillLink(getTerminalToken());
    if (stopped) return;
    useLink.getState().set(sellingBlock(answer));
    timer = window.setTimeout(() => void ask(), everyMs);
  };
  void ask();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    useLink.getState().set(null);
  };
}
