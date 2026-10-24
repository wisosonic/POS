import { describe, expect, it } from 'vitest';
import { rememberedShopName, setShopTitle } from '../../apps/web/src/lib/shopTitle';

// The browser tab shows the shop's name, remembered on this computer for the sign-in page.
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('the tab title', () => {
  it('becomes the shop name and is remembered', () => {
    const store = memory();
    const doc = { title: 'Till' };
    setShopTitle('  Darwish Market ', store, doc);
    expect(doc.title).toBe('Darwish Market');
    expect(rememberedShopName(store)).toBe('Darwish Market');
  });

  it('keeps the old title when there is no name yet', () => {
    const store = memory();
    const doc = { title: 'Till' };
    setShopTitle(undefined, store, doc);
    setShopTitle('   ', store, doc);
    expect(doc.title).toBe('Till');
    expect(rememberedShopName(store)).toBeNull();
  });

  it('still changes the title when storage refuses or is blocked', () => {
    const doc = { title: 'Till' };
    setShopTitle(
      'Shop',
      {
        setItem: () => {
          throw new Error('blocked');
        },
      },
      doc,
    );
    expect(doc.title).toBe('Shop');
    expect(
      rememberedShopName({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBeNull();
    expect(rememberedShopName(null)).toBeNull();
  });
});
