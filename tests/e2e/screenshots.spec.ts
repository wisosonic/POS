import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// A visual walk through the till, saving a picture of each screen. Not a pass/fail check of behaviour (checkout.spec.ts is);
// it exists so the screens can be looked at. Run it with:  SHOTS=./shots npx playwright test screenshots
const out = process.env.SHOTS;
test.skip(!out, 'set SHOTS=<folder> to take screenshots');

const shot = async (page: Page, name: string) => {
  mkdirSync(out!, { recursive: true });
  await page.screenshot({ path: join(out!, `${name}.png`) });
};
const scan = async (page: Page, code: string) => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
};

test('back office', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/products');
  await expect(page.getByTestId('product-row').first()).toBeVisible();
  await shot(page, '20-products');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Currency').selectOption('USD');
  await shot(page, '21-product-form');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.goto('/products/lists');
  await expect(page.getByRole('tab', { name: 'Units' })).toBeVisible();
  await page.getByRole('tab', { name: 'Units' }).click();
  await shot(page, '22-lists-units');

  // the admin's screens
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('test-admin-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await shot(page, '25-settings');
  await page.goto('/rate');
  await expect(page.getByTestId('current-rate')).toBeVisible();
  await shot(page, '26-rate');
});

test('screens', async ({ page }) => {
  await page.goto('/login');
  await shot(page, '01-login');

  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('3,000,000');
    await page.getByLabel('Cash USD').fill('70');
    await page.getByLabel('Whish LBP').fill('500000');
    await page.getByLabel('OMT LBP').fill('1000000');
    await shot(page, '02-open-register');
    await open.click();
  }
  await expect(page.getByTestId('checkout')).toBeVisible();
  await shot(page, '03-checkout-empty');

  await scan(page, '5287000107945');
  await scan(page, '9342390005250');
  await scan(page, '9342390005250');
  await scan(page, '2000000000008'); // loose cheese, sold by weight: the quantity box is focused for the weight
  await shot(page, '04-checkout-cart');

  await page.getByRole('searchbox').fill('cris');
  await shot(page, '05-search');
  await page.getByRole('searchbox').fill('');

  await page.getByRole('button', { name: /PAY/ }).click();
  await shot(page, '06-pay-empty');
  await page.getByLabel('Cash LBP').fill('25000');
  await shot(page, '07-pay-walkin-blocked');
  await page.getByRole('button', { name: 'Customer' }).click();
  await page.getByPlaceholder('Search customer').fill('ahmad');
  await expect(page.getByRole('option', { name: /ahmad darwish/i })).toBeVisible();
  await shot(page, '08-pay-customer-picker');
  await page.getByRole('option', { name: /ahmad darwish/i }).click();
  await shot(page, '09-pay-on-account');

  await page.getByLabel('Cash LBP').fill('600000');
  await page.getByLabel('OMT LBP').fill('');
  await shot(page, '10-pay-change');
  await page.getByLabel('Cash LBP').fill('300000'); // part-paid: the rest stays on Ahmad's account
  await expect(page.getByTestId('rest-due')).toBeVisible();
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  await shot(page, '11-sale-completed');

  await scan(page, '5287000107945');
  await page.getByRole('button', { name: /Hold/ }).click();
  await expect(page.getByRole('button', { name: /Holds/ })).toBeVisible();
  await page.getByRole('button', { name: /Holds/ }).click();
  await shot(page, '12-holds');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /Menu/ }).click();
  await shot(page, '13-menu');
  await page.getByRole('link', { name: 'Customer accounts' }).click();
  await expect(page.getByRole('row', { name: /ahmad darwish/i })).toBeVisible();
  await shot(page, '14-accounts');
  await page.getByRole('button', { name: 'Receive payment' }).first().click();
  await shot(page, '15-receive-payment');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Low stock' }).click();
  await expect(page.getByTestId('low-stock-row').first()).toBeVisible();
  await shot(page, '16-low-stock');

  // the cashier cannot see the manager's pages, so look at them as the manager, with the sale made above in the figures
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout')).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByTestId('top-item').first()).toBeVisible();
  await shot(page, '23-dashboard');
  await page.goto('/reports');
  await expect(page.getByTestId('report-total')).toBeVisible();
  await shot(page, '24-reports-sales');
  await page.goto('/reports?tab=sessions');
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout')).toBeVisible();

  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Close register' }).click();
  await page.getByLabel('Cash LBP counted').fill('3,500,000');
  await shot(page, '17-close-register');

  await page.setViewportSize({ width: 820, height: 1100 });
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Checkout' }).click();
  await scan(page, '9342390005250');
  await shot(page, '18-tablet-portrait');
});

test('discount', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
  }
  await expect(page.getByTestId('checkout')).toBeVisible();
  await scan(page, '5287000107945');
  await scan(page, '9342390005250');
  await page.keyboard.press('F6');
  await page.getByLabel('Percent off the whole cart').fill('25');
  await shot(page, '30-discount-over-limit');
  await page.getByRole('button', { name: 'Ask a manager' }).click();
  await page.getByLabel("Manager's name").fill('manager');
  await page.getByLabel("Manager's password").fill('wrong');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await shot(page, '31-manager-approval');
  await page.getByLabel("Manager's password").fill('test-manager-pass');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('discount-row')).toBeVisible();
  await shot(page, '32-discount-applied');
});

test('sales screen', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
  }
  await expect(page.getByTestId('checkout')).toBeVisible();
  for (const code of ['5287000107945', '9342390005250']) {
    await scan(page, code);
    await page.getByRole('button', { name: /PAY/ }).click();
    await page.getByLabel('Cash LBP').fill('200000');
    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  }
  await page.goto('/sales');
  await expect(page.getByTestId('sale-row').first()).toBeVisible();
  await shot(page, '50-sales');
  await page
    .getByTestId('sale-row')
    .first()
    .getByRole('button', { name: /Open receipt/ })
    .click();
  await expect(page.getByTestId('receipt-text')).toBeVisible();
  await shot(page, '51-sale-receipt');
});

test('product import', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/products');
  await page.getByRole('button', { name: 'Import CSV…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import products' });
  await shot(page, '60-import-empty');
  const csv =
    'name,barcode,price,currency,category\nShot tea,7830000000011,3.50,USD,Shot teas\nShot coffee,7830000000028,"45,000",LBP,Shot teas\nالحليب,7830000000035,45000,LBP,Shot teas\n';
  await dialog.getByLabel('CSV file').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(dialog.getByTestId('import-summary')).toBeVisible();
  await shot(page, '61-import-problems');
});
