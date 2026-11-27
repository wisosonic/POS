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
  /** How many sales were sent but not confirmed yet (the journal, docs/14 §4.3). A new sale is not taken while there is one. */
  doubt: number;
  setDoubt: (doubt: number) => void;
};

export const useLink = create<LinkStore>((set) => ({
  block: null,
  set: (block) => set({ block }),
  doubt: 0,
  setDoubt: (doubt) => set({ doubt }),
}));

/** True while no new payment may be taken: the branch server is not answering, or a sale is still waiting for its confirmation. */
export const useSellingStopped = (): boolean => useLink((s) => s.block !== null || s.doubt > 0);
/** The same, read outside a component (a key press). */
export const sellingStoppedNow = (): boolean => {
  const s = useLink.getState();
  return s.block !== null || s.doubt > 0;
};

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
