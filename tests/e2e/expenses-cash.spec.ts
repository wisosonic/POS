import { test, expect, type Page } from '@playwright/test';

// US-24 expenses and US-13 cash movements, through the manager's screens. Same throwaway stack as the other specs.

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

const balance = async (page: Page, name: string) => {
  const row = page.getByRole('table', { name: 'Balances now' }).getByRole('row', { name: new RegExp(`^${name}`) });
  return Number(((await row.getByRole('cell').nth(1).textContent()) ?? '').replace(/[^\d.-]/g, ''));
};

test('US-24: an expense paid from the drawer lowers what the drawer should hold; one paid elsewhere does not', async ({ page }) => {
  await managerLogin(page);
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Cash in and out' }).click();
  await expect(page.getByRole('table', { name: 'Balances now' })).toBeVisible();
  const before = await balance(page, 'Cash LBP');

  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Expenses', exact: true }).click();
  await page.getByRole('button', { name: 'New expense' }).click();
  await page.getByLabel('What was it for').fill('Bread delivery');
  await page.getByLabel('Amount (LBP)').fill('150000');
  await page.getByLabel('Paid from').selectOption('cash');
  await page.getByRole('button', { name: 'Save expense' }).click();
  const row = page.getByTestId('expense-row').filter({ hasText: 'Bread delivery' });
  await expect(row).toContainText('From the till');
  await expect(row).toContainText('150,000 LL');

  await page.getByRole('button', { name: 'New expense' }).click();
  await page.getByLabel('What was it for').fill('Rent');
  await page.getByLabel('Amount (LBP)').fill('5000000');
  await page.getByRole('button', { name: 'Save expense' }).click();
  await expect(page.getByTestId('expense-row').filter({ hasText: 'Rent' })).toContainText('Elsewhere');

  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Cash in and out' }).click();
  await expect(page.getByTestId('movement-row').filter({ hasText: 'Expense: Bread delivery' })).toContainText('Out of Cash LBP');
  expect(await balance(page, 'Cash LBP')).toBe(before - 150_000); // the rent never touched the drawer
});

test('US-13: move money between balances; the same balance twice is refused', async ({ page }) => {
  await managerLogin(page);
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Cash in and out' }).click();
  await expect(page.getByRole('table', { name: 'Balances now' })).toBeVisible();
  const [cash, whish] = [await balance(page, 'Cash LBP'), await balance(page, 'Whish LBP')];

  await page.getByRole('button', { name: 'Move money' }).click();
  await page.getByRole('tab', { name: 'Between balances' }).click();
  await page.getByLabel('Amount (LBP)').fill('100000');
  await page.getByLabel('Out of').selectOption('cash');
  await page.getByLabel('Into').selectOption('cash');
  await page.getByLabel('Reason').fill('Top up the wallet');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('alert')).toContainText('two different balances');

  await page.getByLabel('Into').selectOption('whish');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByTestId('movement-row').filter({ hasText: 'Top up the wallet' })).toContainText('Cash LBP → Whish LBP');
  expect(await balance(page, 'Cash LBP')).toBe(cash - 100_000);
  expect(await balance(page, 'Whish LBP')).toBe(whish + 100_000);
});
