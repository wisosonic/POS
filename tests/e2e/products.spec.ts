import { test, expect, type Browser, type Page } from '@playwright/test';

// US-15 / US-16: the manager's back office. Same throwaway stack as checkout.spec.ts.
const PASSWORDS: Record<string, string> = { cashier: 'test-cashier-pass', manager: 'test-manager-pass' };

async function login(page: Page, user: 'cashier' | 'manager') {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(PASSWORDS[user]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Sign in as the manager and land on a back-office page. These pages work whether or not a register is open. */
async function managerAt(page: Page, path: string) {
  await login(page, 'manager');
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

async function openMenu(page: Page, link: string) {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: link, exact: true }).click();
}

async function cashierPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await login(page, 'cashier');
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    for (const [label, v] of [
      ['Cash LBP', '1000000'],
      ['Cash USD', '10'],
    ]) {
      await page.getByLabel(label!).fill(v!);
    }
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
  return page;
}

test('US-15: a manager adds a dollar product, changes its price, and the till sells it at the new price', async ({
  page,
  browser,
  baseURL,
}) => {
  await managerAt(page, '/products');

  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Zaatar mix');
  await page.getByLabel('Barcode').fill('7771234500012');
  await page.getByLabel('Currency').selectOption('USD');
  await page.getByLabel('Selling price (USD)').fill('4.50');
  await page.getByLabel('Cost (USD)').fill('3');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('searchbox').fill('zaatar');
  const row = page.getByTestId('product-row').filter({ hasText: 'Zaatar mix' });
  await expect(row).toContainText('$4.50');

  await row.getByRole('button', { name: /Edit/ }).click();
  await page.getByLabel('Selling price (USD)').fill('5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('$5.00');
  await expect(row).toContainText('$3.00'); // an edit of the price leaves the cost alone

  // The cashier's till picks the new product up and prices it at $5.00 = 450,000 LL (rate 90,000).
  const till = await cashierPage(browser, baseURL);
  await till.reload();
  await expect(till.getByTestId('checkout')).toBeVisible();
  // The till's copy of the catalog may still be arriving, so a scan that comes first is retried (it is only lost, never doubled).
  await expect(async () => {
    await till.locator('body').click({ position: { x: 5, y: 5 } });
    await till.keyboard.type('7771234500012', { delay: 5 });
    await till.keyboard.press('Enter');
    await expect(till.getByTestId('cart-total')).toHaveText(/450,000/, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
});

test('US-15: a hidden product leaves the default list, shows under "Show hidden", and can be restored', async ({ page }) => {
  await managerAt(page, '/products');
  await page.getByRole('searchbox').fill('towel');
  const row = page.getByTestId('product-row').first();
  await row.getByRole('button', { name: /Edit/ }).click();
  await page.getByLabel(/Sold in the shop/).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('product-row')).toHaveCount(0);

  await page.getByLabel('Show hidden products').check();
  const hidden = page.getByTestId('product-row').first();
  await expect(hidden).toContainText('Hidden');
  await hidden.getByRole('button', { name: /Edit/ }).click();
  await page.getByLabel(/Sold in the shop/).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Show hidden products').uncheck();
  await expect(page.getByTestId('product-row').first()).not.toContainText('Hidden');
});

test('US-15: a new category appears in the product form; a duplicate name is refused', async ({ page }) => {
  await managerAt(page, '/products/lists');
  await page.getByLabel('New category').fill('Spices');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('lookup-row').filter({ hasText: 'Spices' })).toBeVisible();

  await page.getByLabel('New category').fill('spices');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(/already a category/i)).toBeVisible();

  await openMenu(page, 'Products');
  await expect(page.getByLabel('Category').locator('option', { hasText: 'Spices' })).toHaveCount(1); // the list's filter offers it too
  await page.getByRole('button', { name: 'New product' }).click();
  await expect(page.getByRole('dialog').getByLabel('Category').locator('option', { hasText: 'Spices' })).toHaveCount(1);
});

test('US-26: a cashier has no Products menu and is sent back to the till from /products', async ({ browser, baseURL }) => {
  const page = await cashierPage(browser, baseURL);
  await page.getByRole('button', { name: /Menu/ }).click();
  await expect(page.getByRole('link', { name: 'Products', exact: true })).toHaveCount(0);
  await page.goto('/products');
  await expect(page).toHaveURL(/\/$/);
});

test('US-15: the product list can be filtered by category and by brand', async ({ page, request }) => {
  // a brand with one product, made through the API (the screen only picks from existing brands)
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: PASSWORDS.manager } });
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const brand = await (await request.post('/api/v1/brands', { headers, data: { name: 'Filterbrand' } })).json();
  const made = await request.post('/api/v1/products', {
    headers,
    data: { name: 'Branded kettle', barcode: '7790000000015', priceMinor: 90000, currency: 'LBP', brandId: brand.id },
  });
  expect(made.status()).toBe(201);

  await managerAt(page, '/products');
  const rows = page.getByTestId('product-row');
  await expect(rows.filter({ hasText: 'Cedars silver towel' })).toHaveCount(1);

  await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Household' });
  await expect(rows.filter({ hasText: 'Cedars silver towel' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Crispy chocolate' })).toHaveCount(0); // another category
  await expect(rows.filter({ hasText: 'Branded kettle' })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Snacks' });
  await expect(rows.filter({ hasText: 'Crispy chocolate' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Cedars silver towel' })).toHaveCount(0);

  // both filters have to match: no Snacks product has this brand
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Filterbrand' });
  await expect(page.getByText('No products match these filters.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'All categories' });
  await expect(rows.filter({ hasText: 'Branded kettle' })).toHaveCount(1);
  await expect(rows).toHaveCount(1); // only that brand's product

  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'All brands' });
  await expect(rows.filter({ hasText: 'Cedars silver towel' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Branded kettle' })).toHaveCount(1);
});

test('US-17: the low stock threshold is a number with a "No alert" tick box; 0 is a real threshold', async ({ page }) => {
  await managerAt(page, '/products');
  await page.getByRole('searchbox').fill('Loose cheese'); // seeded with 5 kg in stock and no threshold
  const row = page.getByTestId('product-row').filter({ hasText: 'Loose cheese' });
  await expect(row.getByTestId('low-at')).toHaveText('');
  const edit = async () => {
    await row.getByRole('button', { name: /Edit/ }).click();
    return page.getByRole('dialog');
  };
  const lowStockHas = async (yes: boolean) => {
    await openMenu(page, 'Low stock');
    await expect(page.getByTestId('low-stock-row').filter({ hasText: 'Loose cheese' })).toHaveCount(yes ? 1 : 0);
    await openMenu(page, 'Products');
    await page.getByRole('searchbox').fill('Loose cheese');
  };

  // no threshold to begin with: the box is ticked and the number is switched off
  let dialog = await edit();
  const threshold = dialog.getByLabel('Low stock threshold');
  const noAlert = dialog.getByLabel('No alert for this product');
  await expect(threshold).toHaveAttribute('type', 'number');
  await expect(noAlert).toBeChecked();
  await expect(threshold).toBeDisabled();

  // untick it: a number is needed, and a negative one is refused
  await noAlert.uncheck();
  await expect(threshold).toBeEnabled();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Type the low stock threshold');
  await threshold.fill('-1');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Type the low stock threshold');

  // 0 is kept as 0 (not "no alert"); 5 kg in stock is above it, so nothing is flagged yet
  await threshold.fill('0');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId('low-at')).toHaveText('0');
  await lowStockHas(false);

  // a higher threshold flags it (5 is at or below 8)
  dialog = await edit();
  await expect(dialog.getByLabel('No alert for this product')).not.toBeChecked();
  await expect(dialog.getByLabel('Low stock threshold')).toHaveValue('0'); // 0 comes back as 0
  await dialog.getByLabel('Low stock threshold').fill('8');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId('low-at')).toHaveText('8');
  await lowStockHas(true);

  // put it back: ticking No alert switches the number off and removes the alert
  dialog = await edit();
  await dialog.getByLabel('No alert for this product').check();
  await expect(dialog.getByLabel('Low stock threshold')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId('low-at')).toHaveText('');
  await lowStockHas(false);
});

test('US-15: on the Lists page a category or a brand opens the products that belong to it', async ({ page, request }) => {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: PASSWORDS.manager } });
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const brand = await (await request.post('/api/v1/brands', { headers, data: { name: 'Listbrand' } })).json();
  const made = await request.post('/api/v1/products', {
    headers,
    data: { name: 'Listed lamp', barcode: '7790000000022', priceMinor: 120000, currency: 'LBP', brandId: brand.id },
  });
  expect(made.status()).toBe(201);

  await managerAt(page, '/products/lists');
  // categories (the first tab): Household has only the towel
  await page.getByRole('link', { name: 'Browse the products of Household' }).click();
  await expect(page).toHaveURL(/\/products\?categoryId=\d+$/);
  await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue(/\d+/);
  await expect(page.getByTestId('product-row').filter({ hasText: 'Cedars silver towel' })).toHaveCount(1);
  await expect(page.getByTestId('product-row').filter({ hasText: 'Crispy chocolate' })).toHaveCount(0);

  // brands: the brand's own product only
  await openMenu(page, 'Lists');
  await page.getByRole('tab', { name: 'Brands' }).click();
  await page.getByRole('link', { name: 'Browse the products of Listbrand' }).click();
  await expect(page).toHaveURL(/\/products\?brandId=\d+$/);
  await expect(page.getByRole('combobox', { name: 'Brand' })).toHaveValue(/\d+/);
  await expect(page.getByTestId('product-row')).toHaveCount(1);
  await expect(page.getByTestId('product-row').first()).toContainText('Listed lamp');

  // the other lists are plain names (nothing to browse)
  await openMenu(page, 'Lists');
  await page.getByRole('tab', { name: 'Units' }).click();
  await expect(page.getByRole('link', { name: /Browse the products of/ })).toHaveCount(0);
});

test('US-15: on the Lists page a supplier opens the products bought from it, and the list can be filtered by supplier', async ({
  page,
  request,
}) => {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: PASSWORDS.manager } });
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const supplier = await (await request.post('/api/v1/suppliers', { headers, data: { name: 'Listsupplier' } })).json();
  const made = await request.post('/api/v1/products', {
    headers,
    data: { name: 'Supplied fan', barcode: '7790000000039', priceMinor: 150000, currency: 'LBP', supplierId: supplier.id },
  });
  expect(made.status()).toBe(201);

  await managerAt(page, '/products/lists');
  await page.getByRole('tab', { name: 'Suppliers' }).click();
  await page.getByRole('link', { name: 'Browse the products of Listsupplier' }).click();
  await expect(page).toHaveURL(/\/products\?supplierId=\d+$/);
  await expect(page.getByRole('combobox', { name: 'Supplier' })).toHaveValue(/\d+/);
  await expect(page.getByTestId('product-row')).toHaveCount(1);
  await expect(page.getByTestId('product-row').first()).toContainText('Supplied fan');

  // the same filter box on the Products page, and clearing it brings everything back
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'All suppliers' });
  await expect(page.getByTestId('product-row').filter({ hasText: 'Cedars silver towel' })).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Test Supplier' });
  await expect(page.getByTestId('product-row').filter({ hasText: 'Cedars silver towel' })).toHaveCount(1); // the seeded products
  await expect(page.getByTestId('product-row').filter({ hasText: 'Supplied fan' })).toHaveCount(0);
});
