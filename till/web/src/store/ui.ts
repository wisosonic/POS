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

export const useUi = create<UiState>((set) => ({
  holdsOpen: false,
  setHoldsOpen: (holdsOpen) => set({ holdsOpen }),
  catalogVersion: 0,
  catalogReady: false,

  // Fill the screen's catalog from the feed (on a till PC the till's own server answers it from its disk copy, docs/14 §4), and
  // bring it up to date whenever something says the catalog changed.
  async loadCatalog() {
    const bump = () => set((s) => ({ catalogVersion: s.catalogVersion + 1 }));
    try {
      await catalog.sync();
      set({ catalogReady: true });
      bump();
    } catch {
      if (catalog.size > 0) set({ catalogReady: true });
    }
  },
}));
