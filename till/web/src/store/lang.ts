import { create } from 'zustand';
import { applyLang, readLang, saveLang, translate, type Lang, type Vars } from '../lib/i18n';

type LangState = { lang: Lang; setLang: (lang: Lang) => void };

/** The chosen language. Changing it redraws every screen that uses useT() and turns the page the right way round. */
export const useLang = create<LangState>((set) => ({
  lang: readLang(),
  setLang(lang) {
    saveLang(lang);
    applyLang(lang);
    set({ lang });
  },
}));

/** The translating function for a screen: const t = useT(); t('Checkout'); t('Register #{n}', { n: 3 }). */
export function useT() {
  const lang = useLang((s) => s.lang);
  return (text: string, vars?: Vars) => translate(text, lang, vars);
}

/** For code that is not a screen (a toast after a failed request): the text in the language chosen right now. */
export const tNow = (text: string, vars?: Vars) => translate(text, useLang.getState().lang, vars);
