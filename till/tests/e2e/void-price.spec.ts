import { test, expect, type Page } from '@playwright/test';

// US-14b / US-09: cancelling a sale and changing a price at the till, with a manager's own name and password.
// Same throwaway stack as the other specs.
const TOWEL = '5287000107945'; // 75,000

async function signIn(page: Page, user: 'cashier' | 'manager') {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(`test-${user}-pass`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}
async function scan(page: Page, code: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}
async function lastRef(page: Page): Promise<string> {
  const banner = page.getByText(/Sale \d+ completed/);
  await expect(banner).toBeVisible();
  return /Sale (\d+) completed/.exec((await banner.textContent()) ?? '')![1]!;
}
async function approveAs(page: Page, name: string, password: string) {
  const dialog = page.getByRole('dialog', { name: /Manager approval|Cancel this sale|Change the price/ }).last();
  await dialog.getByLabel("Manager's name").fill(name);
  await dialog.getByLabel("Manager's password").fill(password);
  await dialog.getByRole('button', { name: 'Approve' }).click();
}

test('US-14b: a cashier cancels a sale: a reason, then the manager approves; the sale shows as cancelled and the reprint says so', async ({
  page,
}) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  const ref = await lastRef(page);

  await page.goto('/sales');
  await page.getByRole('button', { name: `Open receipt ${ref}` }).click();
  await page.getByRole('button', { name: /Cancel this sale/ }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel this sale' });
  await cancel.getByRole('button', { name: 'Cancel the sale' }).click();
  await expect(cancel.getByRole('alert')).toContainText('Say why'); // a reason is required

  await cancel.getByLabel('Why?').fill('Rang up twice');
  await cancel.getByRole('button', { name: 'Cancel the sale' }).click();
  await expect(cancel).toContainText(`Cancel sale ${ref}: 75,000 LL`); // what the manager is approving
  await approveAs(page, 'manager', 'wrong-password-here');
  await expect(cancel.getByRole('alert')).toBeVisible();
  await approveAs(page, 'manager', 'test-manager-pass');
  await expect(page.getByText(`Sale ${ref} is cancelled`)).toBeVisible();

  // it is still listed, marked cancelled, and cannot be cancelled or returned again
  const row = page.getByTestId('sale-row').filter({ hasText: ref }).first();
  await expect(row).toContainText(/void|cancelled/i);
  await page.getByRole('button', { name: `Open receipt ${ref}` }).click();
  await expect(page.getByTestId('receipt-text')).toContainText('VOIDED SALE');
  await expect(page.getByRole('button', { name: /Cancel this sale/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Return items/ })).toHaveCount(0);
});

test('US-09: a cashier changes a price: a manager approves that price, and the sale goes through at it', async ({ page }) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /Change the price of/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the price' });
  await expect(dialog).toContainText('Catalogue price: 75,000 LL');
  await dialog.getByLabel('Price for one (lira)').fill('60000');
  await expect(dialog).toContainText('A manager has to approve');
  await dialog.getByRole('button', { name: 'Ask a manager' }).click();
  await expect(dialog).toContainText('at 60,000 LL (catalogue 75,000 LL)');
  await approveAs(page, 'manager', 'wrong-password-here');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await approveAs(page, 'manager', 'test-manager-pass');

  const row = page.getByTestId('cart-row');
  await expect(row).toContainText('60,000 LL');
  await expect(page.getByTestId('price-note')).toContainText('approved by');

  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('60000');
  await page.getByRole('button', { name: 'Complete' }).click();
  const ref = await lastRef(page);

  await page.goto('/sales');
  await expect(page.getByTestId('sale-row').filter({ hasText: ref }).first()).toContainText('60,000 LL');
});

test('US-09: a manager changes a price with no one to ask, and can go back to the catalogue price', async ({ page }) => {
  await signIn(page, 'manager');
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /Change the price of/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the price' });
  await dialog.getByLabel('Price for one (lira)').fill('50000');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('cart-row')).toContainText('50,000 LL');
  await expect(page.getByTestId('price-note')).toBeVisible();

  await page.getByRole('button', { name: /Change the price of/ }).click();
  await page.getByRole('dialog', { name: 'Change the price' }).getByRole('button', { name: 'Back to the catalogue price' }).click();
  await expect(page.getByTestId('cart-row')).toContainText('75,000 LL');
  await expect(page.getByTestId('price-note')).toHaveCount(0);
  await page.getByRole('button', { name: /Clear/ }).click();
});
