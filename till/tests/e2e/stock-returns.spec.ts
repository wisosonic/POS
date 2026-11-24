import { test, expect, type Page } from '@playwright/test';

// US-14 returns and US-17 stock adjustments, through the manager's screens. Same throwaway stack as the other specs.
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

async function scan(page: Page, code: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

const numberIn = async (text: Promise<string | null>) => Number((await text)!.replace(/[^\d.-]/g, ''));

test('US-17: a manager takes damaged stock out; the ledger shows it and the quantity follows', async ({ page }) => {
  await managerLogin(page);
  await page.goto('/products');
  await page.getByRole('searchbox').fill('crispy');
  await page.getByRole('button', { name: /Stock of Crispy chocolate/ }).click();

  await expect(page.getByTestId('stock-now')).not.toHaveText('…');
  const before = await numberIn(page.getByTestId('stock-now').textContent());

  await page.getByRole('tab', { name: 'Take out of stock' }).click();
  await page.getByLabel('How many').fill('3');
  await page.getByLabel('Reason').selectOption('Damaged or expired');
  await page.getByRole('button', { name: 'Save change' }).click();

  await expect(page.getByTestId('stock-now')).toHaveText(String(before - 3));
  await expect(page.getByTestId('stock-movement').first()).toContainText('Damaged or expired');
  await expect(page.getByTestId('stock-movement').first()).toContainText('-3');

  // "Other" needs words, and a quantity that is not a number is refused before it reaches the server.
  await page.getByLabel('Reason').selectOption('Other');
  await page.getByLabel('How many').fill('1');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByRole('alert')).toContainText('Say what the reason is');
  await page.getByLabel('How many').fill('abc');
  await page.getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByRole('alert')).toContainText('positive number');
});

test('US-14: return part of a sale, hand the money back, and it cannot be returned twice', async ({ page }) => {
  await managerLogin(page);
  await scan(page, CHOC);
  await expect(page.getByTestId('cart-total')).toHaveText(/50,000/); // wait for the till to take the first scan before the second (a busy PC can stretch a burst of keys)
  await scan(page, CHOC);
  await expect(page.getByTestId('cart-total')).toHaveText(/100,000/);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('100000');
  await page.getByRole('button', { name: 'Complete' }).click();
  const done = page.getByText(/Sale \d+ completed/);
  await expect(done).toBeVisible();
  const ref = /Sale (\d+) completed/.exec((await done.textContent()) ?? '')![1]!;

  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Returns', exact: true }).click();
  await page.getByLabel('Receipt number').fill(ref);
  await page.getByRole('button', { name: 'Find sale' }).click();
  await expect(page.getByTestId('return-line')).toHaveCount(1);

  await page.getByLabel(/Bringing back/).fill('1');
  await page.getByRole('button', { name: 'Return the items' }).click();
  await expect(page.getByText('Hand back 50,000 LL')).toBeVisible(); // paid in full, so the whole value goes back
  await page.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.getByText(/Return \d+ recorded/)).toBeVisible();
  await expect(page.getByTestId('return-line').getByRole('cell', { name: '1', exact: true })).toBeVisible(); // sold 2, so the only "1" is the already-returned column

  // Only one is left to return.
  await page.getByLabel(/Bringing back/).fill('2');
  await page.getByRole('button', { name: 'Return the items' }).click();
  await expect(page.getByRole('alert')).toContainText('Only 1 of');
});

test('US-14: an unknown receipt number says so', async ({ page }) => {
  await managerLogin(page);
  await page.goto('/returns');
  await page.getByLabel('Receipt number').fill('99999999');
  await page.getByRole('button', { name: 'Find sale' }).click();
  await expect(page.getByText('There is no sale with receipt number 99999999.')).toBeVisible();
});
