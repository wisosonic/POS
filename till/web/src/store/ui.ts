import { create } from 'zustand';
import { catalog } from '../lib/catalog';

type UiState = {
  holdsOpen: boolean;
  setHoldsOpen: (open: boolean) => void;
  /** Bumped whenever the catalog copy changes, so screens that search it redraw. */
  catalogVersion: number;
  catalogReady: boolean;
  loadCatalog: () => Promise<void>;
};

export const useUi = create<UiState>((set, get) => ({
  holdsOpen: false,
  setHoldsOpen: (holdsOpen) => set({ holdsOpen }),
  catalogVersion: 0,
  catalogReady: false,

  // Show the copy saved on this computer immediately, then bring it up to date. If the server is unreachable the saved copy
  // is still good enough to sell from.
  async loadCatalog() {
    const bump = () => set((s) => ({ catalogVersion: s.catalogVersion + 1 }));
    if (!get().catalogReady && (await catalog.loadFromCache())) {
      set({ catalogReady: true });
      bump();
    }
    try {
      await catalog.sync();
      set({ catalogReady: true });
      bump();
    } catch {
      if (catalog.size > 0) set({ catalogReady: true });
    }
  },
}));
