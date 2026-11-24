// How the screen looks for the person using this browser: light or dark, and the size of the letters. It is kept in the browser
// itself (a till PC, or a tablet, has its own habits), applied before the first screen is drawn, and never sent to the server.

export type Theme = 'system' | 'light' | 'dark';
export type TextSize = 'small' | 'normal' | 'large' | 'xlarge';
export type Appearance = { theme: Theme; size: TextSize };

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', size: 'normal' };
/** The size of the letters as a share of the browser's own (16 px): every size on the screens is in rem, so all of it follows. */
export const SIZE_PERCENT: Record<TextSize, number> = { small: 90, normal: 100, large: 112.5, xlarge: 125 };

const KEY = 'pos.appearance';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const SIZES = Object.keys(SIZE_PERCENT) as TextSize[];

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null; // private window or blocked storage: the choice just lasts until the page is closed
  }
};

/** What was saved, or the defaults. Anything unreadable or unknown falls back to the default for that part. */
export function readAppearance(store: Store | null = browserStore()): Appearance {
  try {
    const raw = store?.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Appearance>) : {};
    return {
      theme: THEMES.includes(saved.theme as Theme) ? (saved.theme as Theme) : DEFAULT_APPEARANCE.theme,
      size: SIZES.includes(saved.size as TextSize) ? (saved.size as TextSize) : DEFAULT_APPEARANCE.size,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Put the choice on the page: the theme as an attribute the stylesheet reads, the size as the root font size. */
export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  if (a.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = a.theme;
  root.style.fontSize = a.size === 'normal' ? '' : `${SIZE_PERCENT[a.size]}%`;
}

/** Change part of the choice: save it and show it at once. */
export function setAppearance(change: Partial<Appearance>, store: Store | null = browserStore()): Appearance {
  const next = { ...readAppearance(store), ...change };
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* it still applies for this visit */
  }
  applyAppearance(next);
  return next;
}
