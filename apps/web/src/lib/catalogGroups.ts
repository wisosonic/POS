import type { Product } from './types';

export type CatalogGroup = { key: string; categoryId: number | null; name: string; products: Product[] };

export const NO_CATEGORY = 'No category';

/**
 * The catalog for browsing: products grouped by category. Groups are sorted by category name with "No category" last, products
 * by name inside each group, and a category with no products is left out. A product whose category is not in the list (the
 * list has not arrived yet, or the category is gone) is shown under "Category <number>" rather than hidden.
 */
export function groupByCategory(products: Product[], categories: { id: number; name: string }[]): CatalogGroup[] {
  const names = new Map(categories.map((c) => [c.id, c.name.trim()]));
  const groups = new Map<string, CatalogGroup>();
  for (const p of products) {
    const id = p.categoryId ?? null;
    const key = id === null ? 'none' : `c${id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, categoryId: id, name: id === null ? NO_CATEGORY : (names.get(id) ?? `Category ${id}`), products: [] };
      groups.set(key, g);
    }
    g.products.push(p);
  }
  for (const g of groups.values()) g.products.sort((a, b) => a.name.trim().localeCompare(b.name.trim()));
  return [...groups.values()].sort((a, b) => {
    if ((a.categoryId === null) !== (b.categoryId === null)) return a.categoryId === null ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
