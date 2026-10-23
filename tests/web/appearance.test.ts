import { describe, expect, it } from 'vitest';
import { applyAppearance, DEFAULT_APPEARANCE, readAppearance, setAppearance, SIZE_PERCENT } from '../../apps/web/src/lib/appearance';

// Settings > Appearance: light or dark, and the size of the letters, kept in the browser and applied before the first screen.
const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [['pos.appearance', initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};
const fakeRoot = () => ({ dataset: {} as Record<string, string | undefined>, style: { fontSize: '' } }) as unknown as HTMLElement;

describe('what is saved', () => {
  it('starts as: like the computer, normal size', () => {
    expect(readAppearance(memory())).toEqual({ theme: 'system', size: 'normal' });
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE); // storage blocked
  });

  it('reads what was saved, and each part falls back on its own when it is unknown or damaged', () => {
    expect(readAppearance(memory(JSON.stringify({ theme: 'dark', size: 'large' })))).toEqual({ theme: 'dark', size: 'large' });
    expect(readAppearance(memory(JSON.stringify({ theme: 'purple', size: 'large' })))).toEqual({ theme: 'system', size: 'large' });
    expect(readAppearance(memory(JSON.stringify({ theme: 'light', size: 99 })))).toEqual({ theme: 'light', size: 'normal' });
    expect(readAppearance(memory('not json at all'))).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance(memory('null'))).toEqual(DEFAULT_APPEARANCE);
  });

  it('a change keeps the other part, and is saved', () => {
    const store = memory();
    // setAppearance applies to the page too; in this environment there is no page, so give it none to touch
    const root = fakeRoot();
    (globalThis as { document?: unknown }).document = { documentElement: root };
    try {
      expect(setAppearance({ theme: 'dark' }, store)).toEqual({ theme: 'dark', size: 'normal' });
      expect(setAppearance({ size: 'xlarge' }, store)).toEqual({ theme: 'dark', size: 'xlarge' });
      expect(JSON.parse(store.data.get('pos.appearance')!)).toEqual({ theme: 'dark', size: 'xlarge' });
      expect(root.dataset.theme).toBe('dark');
      expect(root.style.fontSize).toBe('125%');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('a storage that refuses to save does not break the change', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    (globalThis as { document?: unknown }).document = { documentElement: fakeRoot() };
    try {
      expect(setAppearance({ theme: 'light' }, refusing)).toEqual({ theme: 'light', size: 'normal' });
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe('what goes on the page', () => {
  it('the theme becomes an attribute (none for "like the computer"), the size becomes the root font size', () => {
    const root = fakeRoot();
    applyAppearance({ theme: 'dark', size: 'large' }, root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.fontSize).toBe('112.5%');
    applyAppearance({ theme: 'light', size: 'small' }, root);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.fontSize).toBe('90%');
    applyAppearance({ theme: 'system', size: 'normal' }, root);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.style.fontSize).toBe('');
  });

  it('the sizes grow in order, and normal is the browser’s own', () => {
    expect(SIZE_PERCENT.normal).toBe(100);
    expect(SIZE_PERCENT.small).toBeLessThan(SIZE_PERCENT.normal);
    expect(SIZE_PERCENT.normal).toBeLessThan(SIZE_PERCENT.large);
    expect(SIZE_PERCENT.large).toBeLessThan(SIZE_PERCENT.xlarge);
  });
});
