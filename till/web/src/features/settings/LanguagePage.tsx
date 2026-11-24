import { Icon } from '../../components/Icon';
import { LANGS } from '../../lib/i18n';
import { useLang, useT } from '../../store/lang';

/** English or Arabic for the screens, on this computer and this browser only. Arabic reads right to left. */
export function LanguagePage() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <main className="page">
      <h1>
        <Icon name="language" size={26} />
        {t('Language')}
      </h1>
      <p className="muted">
        {t('This choice is for this computer and this browser only. It is applied at once and kept the next time you open the till.')}
      </p>
      <fieldset className="choice-group">
        <legend>{t('Language of the screens')}</legend>
        <div className="choices">
          {LANGS.map((l) => (
            <label key={l.code} className={`choice${lang === l.code ? ' on' : ''}`}>
              <input type="radio" name="lang" value={l.code} checked={lang === l.code} onChange={() => setLang(l.code)} />
              <Icon name="language" size={26} />
              <span className="choice-title" lang={l.code}>
                {l.name}
              </span>
              <span className="muted choice-hint">
                {l.code === 'ar' ? t('Arabic: the screens read from right to left.') : t('English')}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="muted">
        {t(
          'Receipts are always printed in English letters, because the receipt printer cannot print Arabic. Product names are shown as they were typed.',
        )}
      </p>
    </main>
  );
}
