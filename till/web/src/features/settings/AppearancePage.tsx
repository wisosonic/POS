import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../store/lang';
import { DEFAULT_APPEARANCE, readAppearance, setAppearance, SIZE_PERCENT, type TextSize, type Theme } from '../../lib/appearance';

const THEMES: { value: Theme; label: string; hint: string; icon: IconName }[] = [
  { value: 'system', label: 'Like this computer', hint: 'Follows the light or dark setting of Windows.', icon: 'monitor' },
  { value: 'light', label: 'Light', hint: 'A bright screen, best in a lit shop.', icon: 'sun' },
  { value: 'dark', label: 'Dark', hint: 'Easier on the eyes in a dim room or at night.', icon: 'moon' },
];
const SIZES: { value: TextSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
];

/** The look of the screen on this computer: light or dark, and the size of the letters. Saved here, for this browser only. */
export function AppearancePage() {
  const t = useT();
  const [a, setA] = useState(readAppearance);
  const change = (part: Partial<typeof a>) => setA(setAppearance(part));

  return (
    <main className="page">
      <h1>
        <Icon name="appearance" size={26} />
        {t('Appearance')}
      </h1>
      <p className="muted">
        {t('This choice is for this computer and this browser only. It is applied at once and kept the next time you open the till.')}
      </p>

      <fieldset className="choice-group">
        <legend>{t('Colours')}</legend>
        <div className="choices">
          {THEMES.map((o) => (
            <label key={o.value} className={`choice${a.theme === o.value ? ' on' : ''}`}>
              <input type="radio" name="theme" value={o.value} checked={a.theme === o.value} onChange={() => change({ theme: o.value })} />
              <Icon name={o.icon} size={26} />
              <span className="choice-title">{t(o.label)}</span>
              <span className="muted choice-hint">{t(o.hint)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="choice-group">
        <legend>{t('Size of the letters')}</legend>
        <div className="choices">
          {SIZES.map((s) => (
            <label key={s.value} className={`choice${a.size === s.value ? ' on' : ''}`}>
              <input type="radio" name="size" value={s.value} checked={a.size === s.value} onChange={() => change({ size: s.value })} />
              <span className="choice-sample" style={{ fontSize: `${SIZE_PERCENT[s.value] / 100}rem` }} aria-hidden="true">
                Aa
              </span>
              <span className="choice-title">{t(s.label)}</span>
            </label>
          ))}
        </div>
        <div className="card preview" aria-label={t('Preview')}>
          <div className="muted">{t('Preview')}</div>
          <div className="preview-name">Almarai Fresh Milk 1L</div>
          <div className="preview-price num">135,000 LL</div>
        </div>
      </fieldset>

      <div>
        <button
          className="btn"
          disabled={a.theme === DEFAULT_APPEARANCE.theme && a.size === DEFAULT_APPEARANCE.size}
          onClick={() => setA(setAppearance({ ...DEFAULT_APPEARANCE }))}
        >
          {t('Back to the usual look')}
        </button>
      </div>
    </main>
  );
}
