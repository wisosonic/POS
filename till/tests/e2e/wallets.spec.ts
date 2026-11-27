import { test, expect, type Page } from '@playwright/test';

// docs/13: the branch's wallets, through the manager's Wallets page. Same throwaway stack as the other specs. The wallets are shared
// by every spec of the run, so the figures are read first and compared relative to each other.

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
const number = (text: string | null) => Number((text ?? '').replace(/[^\d.-]/g, ''));
const expected = async (page: Page) => number(await page.getByTestId('wallet-expected-whish/LBP').textContent());

test('US-12: a manager records a movement, counts the wallets, and sees the difference', async ({ page }) => {
  await managerLogin(page);
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Wallets' }).click();
  await expect(page.getByRole('table', { name: 'Wallet balances' })).toBeVisible();

  // A top-up from the bank raises only the wallet that was named.
  const before = await expected(page);
  await page.getByRole('button', { name: 'Record a movement' }).click();
  await page.getByRole('combobox').selectOption({ label: 'Whish Money LBP' });
  await page.getByLabel('Amount (LBP)').fill('50000');
  await page.getByLabel('Reason').fill('Bank top-up');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId('wallet-entry').filter({ hasText: 'Bank top-up' })).toContainText('+50,000 LL');
  await expect.poll(() => expected(page)).toBe(before + 50_000);

  // A reason is required.
  await page.getByRole('button', { name: 'Record a movement' }).click();
  await page.getByRole('combobox').selectOption({ label: 'Whish Money LBP' });
  await page.getByLabel('Amount (LBP)').fill('1000');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Say why the money moved');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A count must give every wallet; the first count of a wallet is a baseline and a later one shows the difference.
  const now = before + 50_000;
  await page.getByRole('button', { name: 'Count the wallets' }).click();
  await page.getByLabel('Whish Money LBP').fill(String(now - 5000));
  await page.getByRole('button', { name: 'Record the count' }).click();
  await expect(page.getByRole('alert')).toContainText('Count');
  await page.getByLabel('Whish Money USD').fill('0');
  await page.getByLabel('OMT LBP').fill('0');
  await page.getByLabel('OMT USD').fill('0');
  await page.getByRole('button', { name: 'Record the count' }).click();
  await expect(page.getByTestId('wallet-whish/LBP')).toContainText(String(now - 5000).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  await page.getByRole('tab', { name: 'Counts' }).click();
  await expect(page.getByTestId('wallet-count').first()).toBeVisible();

  // The dashboard shows the wallets, and nothing asks for a count: it was done just now.
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('dash-wallet-whish-LBP')).toBeVisible();
  await expect(page.getByTestId('wallet-reminder')).toHaveCount(0);
});

test('US-12: a cashier does not see the Wallets page in the menu', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Menu/ }).click();
  await expect(page.getByRole('link', { name: 'Wallets' })).toHaveCount(0);
});
