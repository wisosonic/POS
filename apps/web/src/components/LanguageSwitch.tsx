import { useLang, useT } from '../store/lang';

/**
 * The language toggle for the header (and the sign-in page): a switch that is off for English and on for Arabic. It shows both
 * names so it can always be found, whichever language the screen is in.
 */
export function LanguageSwitch() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const arabic = lang === 'ar';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={arabic}
      aria-label={t('Arabic')}
      title={t('Switch the language to {name}', { name: arabic ? 'English' : 'العربية' })}
      className={`lang-switch${arabic ? ' on' : ''}`}
      onClick={() => setLang(arabic ? 'en' : 'ar')}
    >
      <span className="lang-opt" data-active={!arabic}>
        EN
      </span>
      <span className="lang-opt" data-active={arabic}>
        ع
      </span>
    </button>
  );
}
