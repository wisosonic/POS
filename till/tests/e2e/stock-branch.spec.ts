import { test, expect, type Page } from '@playwright/test';

// A stock branch is a warehouse with no tills (docs/15 §3): its home says so instead of asking for a register. The branch server's answer is changed on the
// way (`branchKind`), so this needs no HQ; the server's own refusals are tested in cloud-hq.
async function signInAs(page: Page, role: 'cashier' | 'manager', branchKind: 'sale' | 'stock') {
  await page.route('**/api/v1/settings/public', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), branchKind } });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill(role);
  await page.getByLabel('Password').fill(role === 'manager' ? 'test-manager-pass' : 'test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('a stock branch (US-HQ-kind)', () => {
  test('the home says it is a warehouse and never asks to open a register', async ({ page }) => {
    await signInAs(page, 'cashier', 'stock');
    await expect(page.getByTestId('stock-branch')).toContainText('This is a stock branch');
    await expect(page.getByRole('button', { name: 'Open register' })).toHaveCount(0);
    await expect(page.getByTestId('checkout')).toHaveCount(0);
    await expect(page.getByTestId('stock-branch').getByRole('link')).toHaveCount(0); // a cashier gets no stock work links
  });

  test('a manager gets the stock work links', async ({ page }) => {
    await signInAs(page, 'manager', 'stock');
    await expect(page.getByTestId('stock-branch')).toBeVisible();
    await expect(page.getByTestId('stock-branch').getByRole('link', { name: 'Products' })).toBeVisible();
    await expect(page.getByTestId('stock-branch').getByRole('link', { name: 'Stocktake' })).toBeVisible();
  });

  test('a sale branch still shows the till', async ({ page }) => {
    await signInAs(page, 'cashier', 'sale');
    await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
    await expect(page.getByTestId('stock-branch')).toHaveCount(0);
  });
});
