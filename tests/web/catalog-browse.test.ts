import { describe, it, expect } from 'vitest';
import { Catalog } from '../../apps/web/src/lib/catalog';
import { categoryIcon } from '../../apps/web/src/lib/categoryIcon';
import { groupByCategory, NO_CATEGORY } from '../../apps/web/src/lib/catalogGroups';
import { memoryKV } from '../../apps/web/src/lib/kv';
import type { Product } from '../../apps/web/src/lib/types';

// US-02: browsing the whole catalog, grouped by category, beside the search.
const product = (id: number, name: string, categoryId?: number | null): Product => ({
  id,
  name,
  receiptName: null,
  barcode: String(id),
  costMinor: 0,
  priceMinor: 1000,
  currency: 'LBP',
  qty: '0',
  unitName: 'Piece',
  fractional: false,
  stockAlert: null,
  active: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  categoryId,
});
const categories = [
  { id: 1, name: 'Snacks' },
  { id: 2, name: 'Drinks' },
  { id: 3, name: 'Empty category' },
];

describe('grouping the catalog by category', () => {
  const groups = groupByCategory(
    [product(1, 'Crisps', 1), product(2, 'Cola', 2), product(3, 'Biscuits', 1), product(4, 'Loose cheese', null), product(5, 'Water', 2)],
    categories,
  );

  it('puts every product under its own category, and each product appears once', () => {
    expect(groups.map((g) => [g.name, g.products.map((p) => p.name)])).toEqual([
      ['Drinks', ['Cola', 'Water']],
      ['Snacks', ['Biscuits', 'Crisps']],
      [NO_CATEGORY, ['Loose cheese']],
    ]);
    expect(groups.flatMap((g) => g.products)).toHaveLength(5);
  });

  it('sorts categories by name with "No category" last, and products by name inside a category', () => {
    expect(groups.map((g) => g.name)).toEqual(['Drinks', 'Snacks', NO_CATEGORY]);
    expect(groups[1]!.products.map((p) => p.name)).toEqual(['Biscuits', 'Crisps']);
  });

  it('leaves out a category with no products', () => {
    expect(groups.some((g) => g.name === 'Empty category')).toBe(false);
  });

  it('a product from an older saved copy (no category field) goes to "No category"', () => {
    const g = groupByCategory([product(9, 'Old copy')], categories);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ name: NO_CATEGORY, categoryId: null });
  });

  it('a product whose category is not in the list is shown, not hidden', () => {
    const g = groupByCategory([product(9, 'Mystery', 77)], categories);
    expect(g[0]!.name).toBe('Category 77');
    expect(groupByCategory([product(1, 'Crisps', 1)], [])[0]!.name).toBe('Category 1'); // the list has not arrived yet
  });

  it('is empty for an empty catalog', () => {
    expect(groupByCategory([], categories)).toEqual([]);
  });
});

describe('the till’s copy of the catalog, for browsing', () => {
  it('lists every active product by name, and drops a deactivated one', async () => {
    const feeds = [
      { serverTime: 'T1', data: [product(1, 'Zeta', 1), product(2, 'Alpha', 2), product(3, 'Gone', 1)] },
      { serverTime: 'T2', data: [{ ...product(3, 'Gone', 1), active: false }] },
    ];
    const c = new Catalog(memoryKV(), async () => feeds.shift()!);
    await c.sync();
    expect(c.all().map((p) => p.name)).toEqual(['Alpha', 'Gone', 'Zeta']);
    await c.sync();
    expect(c.all().map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('keeps the category in the saved copy, and drops a copy saved before categories were kept so it is fetched whole again', async () => {
    const kv = memoryKV();
    const first = new Catalog(kv, async () => ({ serverTime: 'T1', data: [product(1, 'Crisps', 1)] }));
    await first.sync();
    const again = new Catalog(kv, async () => ({ data: [], serverTime: 'T2' }));
    expect(await again.loadFromCache()).toBe(true);
    expect(again.all()[0]!.categoryId).toBe(1);

    const old = memoryKV();
    await old.set('catalog', { since: 'T0', products: [product(1, 'Crisps')] }); // no version: an older till saved this
    const fresh = new Catalog(old, async () => ({ data: [], serverTime: 'T3' }));
    expect(await fresh.loadFromCache()).toBe(false);
    expect(fresh.lastSync).toBe(''); // so the next sync asks for everything
  });
});

describe('the icon on a category tile', () => {
  it('is chosen from the words in the name, in English or Arabic, and is the plain box when nothing matches', () => {
    expect(categoryIcon('Soft Drinks')).toBe('drink');
    expect(categoryIcon('مشروبات')).toBe('drink');
    expect(categoryIcon('Dairy and cheese')).toBe('dairy');
    expect(categoryIcon('Snacks')).toBe('snack');
    expect(categoryIcon('Hygiene')).toBe('drop');
    expect(categoryIcon('Household')).toBe('home');
    expect(categoryIcon('Grocery')).toBe('basket');
    expect(categoryIcon('Stationery supplies')).toBe('home');
    expect(categoryIcon('Zzz something new')).toBe('products');
  });

  it('the group with no category is a folder, whatever it is called', () => {
    expect(categoryIcon('No category', false)).toBe('folder');
    expect(categoryIcon('Drinks', false)).toBe('folder');
  });
});
