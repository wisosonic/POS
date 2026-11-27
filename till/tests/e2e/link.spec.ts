import { test, expect, type Page } from '@playwright/test';

// docs/14: a till stops selling while the branch server is not answering, says so, keeps the cart, and starts again by itself.
// The dev web server has no till server behind it, so the answer of GET /till/link is made up here (the real one is covered by
// till/agent/tests/link.test.ts and the production-build project).
const TOWEL = '5287000107945'; // 75,000 LBP

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill(process.env.E2E_CASHIER_PASSWORD ?? 'test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('3000000');
    await page.getByLabel('Cash USD').fill('70');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}

async function scan(page: Page, code: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

const link = (over: Record<string, unknown>) => ({
  state: 'connected',
  blocked: false,
  since: new Date().toISOString(),
  lastOkAt: new Date().toISOString(),
  reason: null,
  detail: null,
  ...over,
});

test('US-10: the till stops selling while the branch server does not answer, keeps the cart, and resumes by itself', async ({ page }) => {
  let down = false;
  await page.route('**/till/link', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(down ? link({ state: 'down', blocked: true, reason: 'TIMEOUT', detail: 'Nothing answered in time' }) : link({})),
    }),
  );
  await login(page);
  await scan(page, TOWEL);
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
  await expect(page.getByTestId('selling-stopped')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /PAY/ })).toBeEnabled();

  down = true; // the branch server stops answering
  const banner = page.getByTestId('selling-stopped');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('Selling is stopped');
  await expect(banner).toContainText('check that the branch server PC is on');
  await expect(page.getByRole('button', { name: /PAY/ })).toBeDisabled();
  await expect(page.getByTestId('cart-row')).toHaveCount(1); // the cart is kept
  await page.keyboard.press('F9'); // the keyboard cannot get around it
  await expect(page.getByLabel('Cash LBP')).toHaveCount(0);

  down = false; // and it is back
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: /PAY/ })).toBeEnabled();
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
});

test('US-10: a payment window that is open when the link drops cannot be completed', async ({ page }) => {
  let down = false;
  await page.route('**/till/link', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(down ? link({ state: 'down', blocked: true, reason: 'REFUSED' }) : link({})),
    }),
  );
  await login(page);
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await expect(page.getByRole('button', { name: 'Complete' })).toBeEnabled();
  down = true;
  await expect(page.getByRole('button', { name: 'Complete' })).toBeDisabled({ timeout: 10_000 });
});
