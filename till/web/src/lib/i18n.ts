import { AR } from './ar';

// English and Arabic. The text in the code IS the English: t('Checkout') shows "Checkout" in English and the Arabic from `ar.ts`
// when that is the chosen language. A text with no Arabic yet is shown in English, never blank, so a screen can be translated one at
// a time. Values go in as {name}: t('Register #{n}', { n: 3 }). The choice is kept in this browser and applied before the first
// screen is drawn (the page direction too: Arabic reads right to left).

export type Lang = 'en' | 'ar';
export const LANGS: { code: Lang; name: string; english: string }[] = [
  { code: 'en', name: 'English', english: 'English' },
  { code: 'ar', name: 'العربية', english: 'Arabic' },
];
export const DEFAULT_LANG: Lang = 'en';
const KEY = 'pos.lang';

type Reader = Pick<Storage, 'getItem'> | null;
type Writer = Pick<Storage, 'setItem'> | null;
const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked: the choice just is not remembered
  }
};

export function readLang(store: Reader = storage()): Lang {
  try {
    const v = store?.getItem(KEY);
    return v === 'ar' || v === 'en' ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export const directionOf = (lang: Lang) => (lang === 'ar' ? 'rtl' : 'ltr');

/** Put the language and the reading direction on the page. */
export function applyLang(lang: Lang, root: Pick<HTMLElement, 'setAttribute'> = document.documentElement): void {
  root.setAttribute('lang', lang);
  root.setAttribute('dir', directionOf(lang));
}

export function saveLang(lang: Lang, store: Writer = storage()): void {
  try {
    store?.setItem(KEY, lang);
  } catch {
    /* storage may be full or blocked: the language still changed */
  }
}

export type Vars = Record<string, string | number>;

/** The text in the chosen language, with {name} filled in. Falls back to the English text itself. */
export function translate(text: string, lang: Lang, vars?: Vars, dictionary: Record<string, string> = AR): string {
  const found = lang === 'ar' ? dictionary[text] : undefined;
  const out = found && found.trim() !== '' ? found : text;
  return vars ? out.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : out;
}
