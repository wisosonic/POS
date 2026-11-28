import { type Page } from '@playwright/test';
import { ADMIN, apiAs, expect, signIn, test } from './helpers';

// Purchase orders and stock suggestions in a real browser (docs/18): what to buy becomes a draft, the draft is changed and placed, the supplier is paid in
// part, a draft is cancelled, and a viewer reads everything and changes nothing. Self-contained: it makes its own stock branch, supplier and products.
test.describe.configure({ mode: 'serial' });

const open = async (page: Page, link: string, heading: string) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
};

test('set-up: a stock branch, a supplier and products that should be kept in stock', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  const api = await apiAs(page);
  expect((await api.post('/branches', { code: 'WHS', name: 'Main Warehouse', kind: 'stock' })).status()).toBe(201);
  expect((await api.post('/suppliers', { name: 'Fresh Foods Ltd' })).status()).toBe(201);
  const product = (name: string, barcode: string, costMinor: number, stockAlert?: number) =>
    api.post('/products', {
      name,
      barcode,
      costMinor,
      priceMinor: costMinor * 2,
      currency: 'USD',
      ...(stockAlert === undefined ? {} : { stockAlert }),
    });
  expect((await product('Olive Oil 1L', '7000001', 350, 10)).status()).toBe(201);
  expect((await product('Basmati Rice 5kg', '7000002', 1200, 4)).status()).toBe(201);
  expect((await product('Sea Salt 1kg', '7000003', 80)).status()).toBe(201); // no alert: never suggested
});

test('stock suggestions: what to buy lists what is short, and chosen rows become a draft order', async ({ page }) => {
  await open(page, 'Stock suggestions', 'Stock suggestions');
  const rows = page.getByTestId('reorder-row');
  await expect(rows).toHaveCount(2); // the salt has no alert
  await expect(rows.filter({ hasText: 'Olive Oil 1L' })).toContainText('Main Warehouse');
  await expect(rows.filter({ hasText: 'Olive Oil 1L' }).locator('td.num').nth(4)).toHaveText('20'); // twice the alert of 10, from nothing
  await expect(rows.filter({ hasText: 'Basmati Rice 5kg' }).locator('td.num').nth(4)).toHaveText('8');
  await expect(page.getByRole('button', { name: /Make a draft order from 0 chosen/ })).toBeDisabled();

  await page.getByLabel('Choose Olive Oil 1L for Main Warehouse').check();
  await page.getByLabel('Choose Basmati Rice 5kg for Main Warehouse').check();
  await page.getByRole('button', { name: /Make a draft order from 2 chosen/ }).click();
  await expect(page.getByRole('heading', { name: /^Order #\d+$/, level: 1 })).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'draft' })).toBeVisible();
  const lines = page.getByTestId('order-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Olive Oil 1L' })).toContainText('$3.50');
  await expect(lines.filter({ hasText: 'Olive Oil 1L' })).toContainText('$70.00'); // 20 x 3.50
});

test('a draft is changed (a quantity, a supplier, another product) and a bad quantity cannot be saved', async ({ page }) => {
  await open(page, 'Purchasing', 'Purchasing');
  await page.getByTestId('order-row').first().getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Change the lines' }).click();
  await expect(page.getByRole('heading', { name: /^Change order #\d+$/, level: 1 })).toBeVisible();
  await expect(page.getByTestId('edit-line')).toHaveCount(2);

  await page.getByLabel('Quantity of Olive Oil 1L').fill('24');
  await page.getByLabel('Supplier').selectOption({ label: 'Fresh Foods Ltd' });
  await page.getByLabel('Add a product (name or barcode)').fill('Sea Salt');
  await page.getByRole('button', { name: 'Add Sea Salt 1kg' }).click();
  await expect(page.getByTestId('edit-line')).toHaveCount(3);
  await page.getByLabel('Quantity of Sea Salt 1kg').fill('1.2345'); // four decimals
  await expect(page.getByRole('button', { name: 'Save as a draft' })).toBeDisabled();
  await page.getByLabel('Quantity of Sea Salt 1kg').fill('2.5');
  await page.getByLabel('Unit cost of Sea Salt 1kg').fill('0.8');
  await page.getByRole('button', { name: 'Save as a draft' }).click();

  const lines = page.getByTestId('order-line');
  await expect(lines).toHaveCount(3);
  await expect(lines.filter({ hasText: 'Olive Oil 1L' })).toContainText('24');
  await expect(lines.filter({ hasText: 'Sea Salt 1kg' })).toContainText('2.5');
  await expect(page.getByText('Fresh Foods Ltd')).toBeVisible();
  await expect(page.getByTestId('outstanding')).toHaveText('$182.00'); // 84 + 96 + 2
});

test('placing it freezes the lines, and the suggestions stop asking for what is already on order', async ({ page }) => {
  await open(page, 'Purchasing', 'Purchasing');
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('order-row').first().getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Place the order' }).click();
  await expect(page.getByText('Placed. Each stock branch is told what to expect.')).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'ordered' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change the lines' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place the order' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Stock suggestions', exact: true }).click();
  await expect(page.getByText('Nothing needs buying right now.')).toBeVisible(); // 24 and 8 are on order, above the alerts
});

test('paying the supplier: a part payment lowers what is owed, more than is owed is refused, and the list shows what HQ owes', async ({
  page,
}) => {
  await open(page, 'Purchasing', 'Purchasing');
  await expect(page.getByTestId('payables')).toContainText('Fresh Foods Ltd');
  await expect(page.getByTestId('payables')).toContainText('$182.00');
  await page.getByTestId('order-row').first().getByRole('button', { name: 'Open' }).click();

  await page.getByLabel('Amount (USD)').fill('100');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await expect(page.getByText('The payment is recorded.')).toBeVisible();
  await expect(page.getByTestId('outstanding')).toHaveText('$82.00');

  await page.getByLabel('Amount (USD)').fill('200');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await expect(page.getByRole('alert')).toBeVisible(); // HQ explains the refusal in its own words
  await expect(page.getByTestId('outstanding')).toHaveText('$82.00');
  await page.getByLabel('Amount (USD)').fill('0.5x');
  await expect(page.getByRole('button', { name: 'Record the payment' })).toBeDisabled();

  await page.getByRole('button', { name: /All orders/ }).click();
  await expect(page.getByTestId('payables')).toContainText('$82.00');
});

test('a new order from scratch can be cancelled while it is a draft', async ({ page }) => {
  await open(page, 'Purchasing', 'Purchasing');
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByRole('heading', { name: 'New order', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as a draft' })).toBeDisabled(); // no lines yet
  await page.getByLabel('Add a product (name or barcode)').fill('Olive');
  await page.getByRole('button', { name: 'Add Olive Oil 1L' }).click();
  await page.getByLabel('Quantity of Olive Oil 1L').fill('3');
  await page.getByRole('button', { name: 'Save as a draft' }).click();
  await expect(page.getByRole('heading', { name: /^Order #\d+$/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel the order' }).click();
  await expect(page.getByText('Cancelled.')).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'cancelled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place the order' })).toHaveCount(0);
});

test('slow and fast shops: the numbers of days are checked before anything is asked', async ({ page }) => {
  await open(page, 'Stock suggestions', 'Stock suggestions');
  await page.getByRole('tab', { name: 'Slow shops' }).click();
  await expect(page.getByText('No shop is holding too much.')).toBeVisible();
  await page.getByLabel('Keep (days of cover)').fill('0');
  await expect(page.getByText('Each number of days is a whole number from 1 to 365.')).toBeVisible();
  await page.getByLabel('Keep (days of cover)').fill('30');
  await page.getByRole('tab', { name: 'Fast shops' }).click();
  await expect(page.getByText('No shop is about to run out.')).toBeVisible();
});

test('a viewer reads orders and suggestions and is offered no way to change or pay anything', async ({ page, browser }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  const api = await apiAs(page);
  expect(
    (await api.post('/users', { username: 'viewer.buy', name: 'Buyer Viewer', role: 'viewer', password: 'Temporary-Pass-123' })).status(),
  ).toBe(201);

  const other = await browser.newContext();
  const vp = await other.newPage();
  await signIn(vp, 'viewer.buy', 'Temporary-Pass-123');
  await vp.getByLabel('The password you were given').fill('Temporary-Pass-123');
  await vp.getByLabel(/^New password \(at least/).fill('Buyer-Own-Password-2026');
  await vp.getByLabel('New password again').fill('Buyer-Own-Password-2026');
  await vp.getByRole('button', { name: 'Save password' }).click();
  await vp.getByRole('link', { name: 'Purchasing', exact: true }).click();
  await expect(vp.getByTestId('order-row').first()).toBeVisible();
  await expect(vp.getByRole('button', { name: 'New order' })).toHaveCount(0);
  await vp.getByTestId('order-row').first().getByRole('button', { name: 'Open' }).click();
  await expect(vp.getByTestId('order-line').first()).toBeVisible();
  for (const hidden of ['Place the order', 'Change the lines', 'Cancel the order', 'Record the payment'])
    await expect(vp.getByRole('button', { name: hidden })).toHaveCount(0);
  await vp.getByRole('link', { name: 'Stock suggestions', exact: true }).click();
  await expect(vp.getByRole('heading', { name: 'Stock suggestions', level: 1 })).toBeVisible();
  await expect(vp.getByRole('button', { name: /Make a draft order/ })).toHaveCount(0);
  await other.close();
});
