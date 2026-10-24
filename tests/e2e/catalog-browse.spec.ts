import { test, expect, type Page } from '@playwright/test';

// US-02: browse the whole catalog beside the search: a grid of category squares, then a category's products with a way back.
// The test seed has Household (the towel), Snacks (the chocolate), Drinks (the latte), and two products without a category.
// Other specs may add more, so nothing here counts them.
async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill(process.env.E2E_CASHIER_PASSWORD ?? 'test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}
const tile = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+ products?$`) });
const catalog = (page: Page) => page.getByRole('region', { name: 'Product catalog' });
const toAll = (page: Page) => page.getByRole('button', { name: 'All categories' });

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('US-02: the catalog button shows and hides the full catalog, beside the search', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Browse catalog' });
  await expect(catalog(page)).toHaveCount(0); // hidden to begin with
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  await expect(catalog(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide catalog' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('searchbox')).toBeVisible(); // the search is still there

  await page.getByRole('button', { name: 'Hide catalog' }).click();
  await expect(catalog(page)).toHaveCount(0);
});

test('US-02: the categories are a grid of squares with an icon, a name and a count, in order, with "No category" last', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Browse catalog' }).click();
  const tiles = page.getByTestId('category-tile');
  const names = await tiles.locator('.catalog-name').allTextContents();
  expect(names).toEqual([...names].sort((a, b) => (a === 'No category' ? 1 : b === 'No category' ? -1 : a.localeCompare(b))));
  for (const seeded of ['Drinks', 'Household', 'Snacks', 'No category']) expect(names).toContain(seeded);
  expect(names.at(-1)).toBe('No category');
  await expect(page.getByTestId('catalog-summary')).toContainText(/\d+ products in \d+ categories/);

  // every tile has an icon and is square (the same width and height)
  await expect(tiles.first().locator('svg.icon')).toBeVisible();
  const box = (await tiles.first().boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
  // no product is listed until a category is opened
  await expect(page.getByText('Cedars silver towel')).toHaveCount(0);
});

test('US-02: a category opens to its own products, and "All categories" goes back to the grid', async ({ page }) => {
  await page.getByRole('button', { name: 'Browse catalog' }).click();

  await tile(page, 'Household').click();
  await expect(page.getByRole('heading', { name: 'Household' })).toBeVisible();
  const household = page.getByRole('list', { name: 'Household' });
  await expect(household.getByText('Cedars silver towel')).toBeVisible();
  await expect(household.getByText('Crispy chocolate')).toHaveCount(0); // only this category's products
  await expect(page.getByTestId('category-tile')).toHaveCount(0); // the grid is replaced, not shown beside it

  await toAll(page).click();
  await expect(page.getByTestId('category-tile').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Household' })).toHaveCount(0);

  await tile(page, 'Snacks').click();
  await expect(page.getByRole('list', { name: 'Snacks' }).getByText('Crispy chocolate')).toBeVisible();
  await toAll(page).click();
  await tile(page, 'Drinks').click();
  await expect(page.getByRole('list', { name: 'Drinks' }).getByText('Starbucks Caffe Latte 220ml')).toBeVisible();
  await toAll(page).click();
  await tile(page, 'No category').click();
  const none = page.getByRole('list', { name: 'No category' });
  await expect(none.getByText('Rare item')).toBeVisible();
  await expect(none.getByText('Loose cheese')).toBeVisible();
});

test('US-02: a product picked from a category goes in the cart and the category stays open; searching takes over and gives it back', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Browse catalog' }).click();
  await tile(page, 'Snacks').click();
  await page
    .getByRole('list', { name: 'Snacks' })
    .getByRole('button', { name: /Crispy chocolate/ })
    .click();
  await expect(page.getByTestId('cart-row').filter({ hasText: 'Crispy chocolate' })).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Snacks' })).toBeVisible(); // still open: pick several things in a row

  // typing a search shows its results instead; clearing it brings the same category back
  await page.getByRole('searchbox').fill('towel');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await expect(catalog(page)).toHaveCount(0);
  await page.getByRole('searchbox').fill('');
  await expect(page.getByRole('list', { name: 'Snacks' })).toBeVisible();

  // hiding the catalog and showing it again starts from the categories
  await toAll(page).click();
  await page.getByRole('button', { name: 'Hide catalog' }).click();
  await page.getByRole('button', { name: 'Browse catalog' }).click();
  await expect(page.getByTestId('category-tile').first()).toBeVisible();
});
