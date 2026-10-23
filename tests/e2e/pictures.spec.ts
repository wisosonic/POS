import { test, expect, type Page } from '@playwright/test';

// US-15: product pictures, from the manager's form to the cashier's search results. Same throwaway stack as the other specs.
// A real, decodable 1x1 PNG, so the browser has to show it (not just receive it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const file = (name: string, mimeType: string, buffer: Buffer) => ({ name, mimeType, buffer });

async function managerAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

async function newProduct(page: Page, name: string, barcode: string) {
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Barcode').fill(barcode);
  await page.getByLabel('Selling price').fill('1000');
}

const shown = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test('US-15: a manager adds a product with a picture; it shows in the list and in the cashier’s search', async ({
  page,
  browser,
  baseURL,
}) => {
  await managerAt(page, '/products');
  await newProduct(page, 'Picture cookies', '7770000000017');
  await page.getByLabel('Product picture file').setInputFiles(file('cookies.png', 'image/png', PNG));
  await expect(page.getByRole('img', { name: 'Picture of Picture cookies' })).toBeVisible(); // the preview, before saving
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('searchbox').fill('Picture cookies');
  const row = page.getByTestId('product-row').filter({ hasText: 'Picture cookies' });
  await expect(row.locator('img.thumb')).toHaveAttribute('src', /^\/uploads\/[0-9a-f]{24}\.png$/);
  await expect.poll(() => shown(row.page(), 'tr[data-testid="product-row"] img.thumb')).toBe(true); // the browser really shows it

  // a cashier's till picks it up
  const till = await (await browser.newContext({ baseURL })).newPage();
  await till.goto('/login');
  await till.getByLabel('Username').fill('cashier');
  await till.getByLabel('Password').fill('test-cashier-pass');
  await till.getByRole('button', { name: 'Sign in' }).click();
  const open = till.getByRole('button', { name: 'Open register' });
  await expect(open.or(till.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await till.getByLabel('Cash LBP').fill('1000000');
    await open.click();
  }
  await expect(till.getByTestId('checkout')).toBeVisible();
  await till.getByRole('searchbox').fill('Picture cookies');
  await expect(till.getByRole('option', { name: /Picture cookies/ }).locator('img')).toHaveAttribute('src', /^\/uploads\//);
});

test('US-15: a picture can be taken off a product', async ({ page }) => {
  await managerAt(page, '/products');
  await newProduct(page, 'Removable cookies', '7770000000024');
  await page.getByLabel('Product picture file').setInputFiles(file('a.png', 'image/png', PNG));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('searchbox').fill('Removable cookies');
  const row = page.getByTestId('product-row').filter({ hasText: 'Removable cookies' });
  await expect(row.locator('img.thumb')).toBeVisible();

  await row.getByRole('button', { name: /Edit/ }).click();
  await page.getByRole('button', { name: 'Remove picture' }).click();
  await expect(page.getByRole('button', { name: 'Remove picture' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('img.thumb')).toHaveCount(0);
  await expect(row.locator('.thumb.none')).toContainText('R'); // a plain tile with the first letter
});

test('US-15: a file that is not a picture, or is too big, is refused before it is sent', async ({ page }) => {
  await managerAt(page, '/products');
  await page.getByRole('button', { name: 'New product' }).click();

  await page.getByLabel('Product picture file').setInputFiles(file('notes.txt', 'text/plain', Buffer.from('not a picture')));
  await expect(page.getByRole('alert')).toContainText('not a picture the shop can use');

  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]);
  await page.getByLabel('Product picture file').setInputFiles(file('huge.png', 'image/png', big));
  await expect(page.getByRole('alert')).toContainText('under 5 MB');
  await expect(page.getByRole('img', { name: /Picture of/ })).toHaveCount(0); // neither was accepted
});

test('US-15: a picture the server will not take does not lose the product', async ({ page }) => {
  await managerAt(page, '/products');
  await newProduct(page, 'Fake picture cookies', '7770000000031');
  // It has a picture's name and type, but its bytes are a web page: only the server can tell.
  await page
    .getByLabel('Product picture file')
    .setInputFiles(file('fake.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/The product was saved, but its picture was not/)).toBeVisible();
  await page.getByRole('searchbox').fill('Fake picture cookies');
  const row = page.getByTestId('product-row').filter({ hasText: 'Fake picture cookies' });
  await expect(row).toBeVisible(); // the product is there
  await expect(row.locator('img.thumb')).toHaveCount(0); // without a picture
});

test('US-15: a picture can be replaced by another', async ({ page }) => {
  await managerAt(page, '/products');
  await newProduct(page, 'Replace cookies', '7770000000048');
  await page.getByLabel('Product picture file').setInputFiles(file('one.png', 'image/png', PNG));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('searchbox').fill('Replace cookies');
  const row = page.getByTestId('product-row').filter({ hasText: 'Replace cookies' });
  const first = await row.locator('img.thumb').getAttribute('src');

  await row.getByRole('button', { name: /Edit/ }).click();
  // a different picture: a GIF (a valid 1x1 one)
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  await page.getByLabel('Product picture file').setInputFiles(file('two.gif', 'image/gif', GIF));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => row.locator('img.thumb').getAttribute('src')).not.toBe(first);
  await expect(row.locator('img.thumb')).toHaveAttribute('src', /\.gif$/);
});
