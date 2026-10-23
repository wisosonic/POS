import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
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
  const [a, setA] = useState(readAppearance);
  const change = (part: Partial<typeof a>) => setA(setAppearance(part));

  return (
    <main className="page">
      <h1>
        <Icon name="appearance" size={26} />
        Appearance
      </h1>
      <p className="muted">
        These choices are for this computer and this browser only. They are applied at once and kept the next time you open the till.
      </p>

      <fieldset className="choice-group">
        <legend>Colours</legend>
        <div className="choices">
          {THEMES.map((t) => (
            <label key={t.value} className={`choice${a.theme === t.value ? ' on' : ''}`}>
              <input type="radio" name="theme" value={t.value} checked={a.theme === t.value} onChange={() => change({ theme: t.value })} />
              <Icon name={t.icon} size={26} />
              <span className="choice-title">{t.label}</span>
              <span className="muted choice-hint">{t.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="choice-group">
        <legend>Size of the letters</legend>
        <div className="choices">
          {SIZES.map((s) => (
            <label key={s.value} className={`choice${a.size === s.value ? ' on' : ''}`}>
              <input type="radio" name="size" value={s.value} checked={a.size === s.value} onChange={() => change({ size: s.value })} />
              <span className="choice-sample" style={{ fontSize: `${SIZE_PERCENT[s.value] / 100}rem` }} aria-hidden="true">
                Aa
              </span>
              <span className="choice-title">{s.label}</span>
            </label>
          ))}
        </div>
        <div className="card preview" aria-label="Preview">
          <div className="muted">Preview</div>
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
          Back to the usual look
        </button>
      </div>
    </main>
  );
}
