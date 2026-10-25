import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AR } from '../../apps/web/src/lib/ar';
import { applyLang, directionOf, readLang, saveLang, translate } from '../../apps/web/src/lib/i18n';
import { NAV, SETTINGS_NAV } from '../../apps/web/src/lib/nav';

// US-37: the screens in English or Arabic. The English text in the code is the key; a text with no Arabic shows in English.
const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [['pos.lang', initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('translating', () => {
  it('shows the English text itself in English', () => {
    expect(translate('Checkout', 'en')).toBe('Checkout');
    expect(translate('Register #{n}', 'en', { n: 3 })).toBe('Register #3');
  });

  it('shows the Arabic when there is one, with the values put in', () => {
    const dictionary = { 'Hello {name}': 'مرحباً {name}', Pay: 'دفع' };
    expect(translate('Pay', 'ar', undefined, dictionary)).toBe('دفع');
    expect(translate('Hello {name}', 'ar', { name: 'Lina' }, dictionary)).toBe('مرحباً Lina');
  });

  it('falls back to the English text when there is no Arabic yet (never blank), and leaves an unknown marker alone', () => {
    expect(translate('A screen nobody has translated', 'ar', undefined, {})).toBe('A screen nobody has translated');
    expect(translate('Needs {thing}', 'ar', {}, {})).toBe('Needs {thing}');
    expect(translate('Empty entry', 'ar', undefined, { 'Empty entry': '  ' })).toBe('Empty entry');
  });
});

describe('the chosen language', () => {
  it('starts as English, and only English or Arabic is accepted back', () => {
    expect(readLang(memory())).toBe('en');
    expect(readLang(memory('ar'))).toBe('ar');
    expect(readLang(memory('fr'))).toBe('en');
    expect(readLang(null)).toBe('en'); // storage blocked
  });

  it('is kept, and a storage that refuses does not break the change', () => {
    const store = memory();
    saveLang('ar', store);
    expect(readLang(store)).toBe('ar');
    expect(() =>
      saveLang('en', {
        setItem: () => {
          throw new Error('full');
        },
      }),
    ).not.toThrow();
    expect(() =>
      readLang({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).not.toThrow();
  });

  it('Arabic reads right to left, and the page gets both the language and the direction', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    const attrs: Record<string, string> = {};
    applyLang('ar', { setAttribute: (k, v) => void (attrs[k] = v) });
    expect(attrs).toEqual({ lang: 'ar', dir: 'rtl' });
    applyLang('en', { setAttribute: (k, v) => void (attrs[k] = v) });
    expect(attrs).toEqual({ lang: 'en', dir: 'ltr' });
  });
});

// ---- the dictionary and the code cannot drift apart
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
/** Every text the screens pass to t() or tNow() as a plain string. */
function usedTexts(): Map<string, string> {
  const found = new Map<string, string>();
  const re = /\b(?:t|tNow)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of files('apps/web/src')) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(re)) found.set(m[2]!.replace(/\\'/g, "'"), file);
  }
  return found;
}
const markers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
/** Labels the screens look up from lists (t(item.label)), so they are not literal calls. */
const FROM_LISTS = [
  ...NAV.flatMap((s) => [s.title, ...s.items.map((i) => i.label)]),
  ...SETTINGS_NAV.map((i) => i.label),
  'Like this computer',
  'Follows the light or dark setting of Windows.',
  'Light',
  'A bright screen, best in a lit shop.',
  'Dark',
  'Easier on the eyes in a dim room or at night.',
  'Small',
  'Normal',
  'Large',
  'Extra large',
  'Cash',
  'Whish',
  'OMT',
  'Cashier',
  'Manager',
  'Admin',
  'Enter what the customer pays',
  'The cart is empty',
  'Select a registered customer to leave a balance on account',
  'A Whish or OMT payment cannot be more than the total, because change can only be given in cash',
  'This payment cannot be used',
];

describe('the Arabic dictionary', () => {
  it('has an entry for every text the screens pass to t()', () => {
    const missing = [...usedTexts()].filter(([text]) => !AR[text]).map(([text, file]) => `${text}  (${file})`);
    expect(missing).toEqual([]);
  });

  it('has an entry for every label picked from a list (the menus, the options)', () => {
    expect(FROM_LISTS.filter((text) => !AR[text])).toEqual([]);
  });

  it('keeps the {markers} of the English text, so no value is lost or invented', () => {
    for (const [text, arabic] of Object.entries(AR)) expect(markers(arabic), text).toEqual(markers(text));
  });

  it('is Arabic: every translation has Arabic letters, except the names that stay as they are', () => {
    const SAME = new Set(['Whish', 'OMT']);
    for (const [text, arabic] of Object.entries(AR)) if (!SAME.has(text)) expect(arabic, text).toMatch(/[؀-ۿ]/);
  });

  it('has no entry that nothing uses (a leftover after a text was changed)', () => {
    const used = new Set([...usedTexts().keys(), ...FROM_LISTS]);
    expect(Object.keys(AR).filter((k) => !used.has(k))).toEqual([]);
  });
});
