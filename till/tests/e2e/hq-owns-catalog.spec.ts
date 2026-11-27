import { test, expect, type Page } from '@playwright/test';

// Connected to HQ, the catalog is HQ's (docs/12 §17): the screens that edit it say so instead of offering buttons the server would refuse.
// The branch server's answer is changed on the way (`hqOwnsCatalog`), so this needs no HQ; the server's own refusals are tested in cloud-hq.
async function managerAt(page: Page, path: string, hqOwnsCatalog: boolean) {
  await page.route('**/api/v1/settings/public', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), hqOwnsCatalog } });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

test.describe('a branch connected to HQ (US-HQ-catalog)', () => {
  test('Products: no add, import or edit, a note says why, stock stays', async ({ page }) => {
    await managerAt(page, '/products', true);
    await expect(page.getByTestId('hq-owns-catalog')).toContainText('Managed at HQ');
    await expect(page.getByRole('button', { name: /New product/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import CSV/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Stock of / }).first()).toBeVisible();
  });

  test('Lists: the four HQ lists are read-only, the branch’s own lists are not', async ({ page }) => {
    await managerAt(page, '/products/lists', true);
    await expect(page.getByTestId('hq-owns-catalog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Expense types' }).click();
    await expect(page.getByTestId('hq-owns-catalog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  });

  test('Duplicate barcodes: nothing to clean up, HQ keeps every barcode unique', async ({ page }) => {
    await managerAt(page, '/barcodes', true);
    await expect(page.getByTestId('hq-owns-catalog')).toContainText('the barcode rule');
    await expect(page.getByTestId('barcode-status')).toHaveCount(0);
  });

  test('not connected: every button is there as before', async ({ page }) => {
    await managerAt(page, '/products', false);
    await expect(page.getByTestId('hq-owns-catalog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /New product/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import CSV/ })).toBeVisible();
  });
});
