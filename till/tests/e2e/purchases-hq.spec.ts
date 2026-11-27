import { test, expect } from '@playwright/test';

// Connected to HQ, HQ buys (docs/15 §6, decision #27): the Purchases page says so and offers no way to make a purchase. The branch server's answer is
// changed on the way (`hqOwnsPurchasing`), so this needs no HQ; the server's own refusals are tested in cloud-hq.
async function managerAtPurchases(page: import('@playwright/test').Page, hqOwnsPurchasing: boolean) {
  await page.route('**/api/v1/settings/public', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), hqOwnsPurchasing } });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/purchases');
}

test.describe('purchasing at a connected branch (US-HQ-purchasing)', () => {
  test('HQ buys: a note says so, and there is no way to make a purchase', async ({ page }) => {
    await managerAtPurchases(page, true);
    await expect(page.getByTestId('hq-buys')).toContainText('HQ buys for the chain');
    await expect(page.getByRole('button', { name: 'New purchase' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open purchase/ })).toHaveCount(0);
  });

  test('not connected: the branch buys for itself as before', async ({ page }) => {
    await managerAtPurchases(page, false);
    await expect(page.getByTestId('hq-buys')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New purchase' })).toBeVisible();
  });
});
