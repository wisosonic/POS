import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// US-27 dashboard and US-28 reports. Other specs also sell in this run, so every check is about how much a figure CHANGED.
const CHOC = '9342390005250'; // 50,000 LBP

async function managerLogin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}

const num = async (page: Page, testId: string) => Number(((await page.getByTestId(testId).textContent()) ?? '').replace(/[^\d-]/g, ''));

async function figures(page: Page) {
  await page.goto('/dashboard');
  await expect(page.getByTestId('net-today')).toBeVisible();
  return { net: await num(page, 'net-today'), profit: await num(page, 'profit-today'), count: await num(page, 'count-today') };
}

test('US-27: a sale adds to today’s figures, and a return takes its value back off', async ({ page }) => {
  await managerLogin(page);
  const before = await figures(page);

  // sell two chocolates (100,000)
  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 2; i++) {
    await page.keyboard.type(CHOC, { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cart-row')).toContainText(i === 0 ? '50,000' : '100,000'); // the till has taken that scan (the catalog may still be loading)
  }
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('100000');
  await page.getByRole('button', { name: 'Complete' }).click();
  const done = page.getByText(/Sale \d+ completed/);
  await expect(done).toBeVisible();
  const ref = /Sale (\d+) completed/.exec((await done.textContent()) ?? '')![1]!;

  const afterSale = await figures(page);
  expect(afterSale.net - before.net).toBe(100000);
  expect(afterSale.count - before.count).toBe(1);
  expect(afterSale.profit - before.profit).toBe(20000); // 2 × (50,000 − 40,000)

  // take one back (50,000)
  await page.goto('/returns');
  await page.getByLabel('Receipt number').fill(ref);
  await page.getByRole('button', { name: 'Find sale' }).click();
  await page.getByLabel(/Bringing back/).fill('1');
  await page.getByRole('button', { name: 'Return the items' }).click();
  await page.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.getByText(/Return \d+ recorded/)).toBeVisible();

  const afterReturn = await figures(page);
  expect(afterReturn.net - before.net).toBe(50000);
  expect(afterReturn.profit - before.profit).toBe(10000);
  expect(afterReturn.count - before.count).toBe(1); // still one sale; the return is not a negative sale
  await expect(page.getByTestId('top-item').first()).toBeVisible();
});

test('US-28: the sales report matches, downloads as a spreadsheet, and the other tabs open', async ({ page }) => {
  await managerLogin(page);
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByTestId('report-total')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download as spreadsheet' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^sales-by-day-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await file.path())!, 'utf8').replace(/^\uFEFF/, '');
  expect(text.split('\r\n')[0]).toBe('Day,Sales,Sold,Taken back,Net,Profit');
  expect(text.split('\r\n').length).toBeGreaterThan(1);

  await page.getByLabel('Group by').selectOption('cashier');
  await expect(page.getByRole('columnheader', { name: 'Cashier' })).toBeVisible();

  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.getByTestId('report-row').filter({ hasText: 'Crispy chocolate' })).toBeVisible();

  await page.getByRole('tab', { name: 'Customers who owe' }).click();
  await expect(page.getByTestId('receivables-total')).toBeVisible();

  await page.getByRole('tab', { name: 'Owed to suppliers' }).click();
  await expect(page.getByTestId('payables-total')).toBeVisible();

  await page.getByRole('tab', { name: 'Closed registers' }).click();
  await page
    .getByRole('button', { name: /Report for register/ })
    .first()
    .click();
  await expect(page.getByRole('dialog').getByRole('row', { name: /^Cash LBP/ })).toBeVisible();
});

test('US-26: a cashier has no dashboard or reports', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/reports');
  await expect(page).toHaveURL(/\/$/);
});
