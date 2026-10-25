import { test, expect, type Page } from '@playwright/test';

// Runs against the API + web app started on a seeded throwaway SQLite file (see tests/helpers/app.ts). Barcodes come from the test seed.
const TOWEL = '5287000107945'; // 75,000 LBP
const CHOC = '9342390005250'; // 50,000 LBP

async function login(page: Page, user = 'cashier') {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(process.env.E2E_CASHIER_PASSWORD ?? 'test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Simulates a keyboard-wedge scanner: very fast keystrokes + Enter, with no input focused. */
async function scan(page: Page, code: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await login(page);
  // After signing in the till shows either the opening dialog (no register yet) or the checkout. Wait for whichever comes.
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('3000000');
    await page.getByLabel('Cash USD').fill('70');
    for (const [label, v] of [
      ['Whish USD', '10'],
      ['Whish LBP', '500000'],
      ['OMT USD', '20'],
      ['OMT LBP', '1000000'],
    ]) {
      await page.getByLabel(label!).fill(v!); // opening wallet balances are set by the cashier at startup (Q6)
    }
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
});

/** Ask the API for the signed-in cashier's sales. The browser holds the session as a cookie, so trade it for a token first. */
async function mySales(page: Page): Promise<{ id: number; clientSaleId: string | null }[]> {
  const { accessToken } = await (await page.request.post('/api/v1/auth/refresh')).json();
  const res = await page.request.get('/api/v1/sales?limit=200', { headers: { Authorization: `Bearer ${accessToken}` } });
  return (await res.json()).data;
}

test('US-01/04/05/06: scan → pay → change → receipt printed', async ({ page, request }) => {
  await scan(page, TOWEL);
  await scan(page, CHOC);
  await scan(page, CHOC);
  await expect(page.getByTestId('cart-row')).toHaveCount(2);
  await expect(page.getByTestId('cart-total')).toHaveText(/175,000/);

  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('200000');
  await expect(page.getByTestId('change-due')).toHaveText(/25,000/);

  const printed = page.waitForRequest((r) => r.url().includes('/print') || r.url().includes('/receipt'));
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  await printed;
  await expect(page.getByTestId('cart-row')).toHaveCount(0);

  // the receipt went to the (fake) USB printer: plain ASCII with the receipt number, the total and the change
  await expect.poll(async () => ((await (await request.get('/__e2e/prints')).json()).data as { text: string }[]).length).toBeGreaterThan(0);
  const prints = (await (await request.get('/__e2e/prints')).json()).data as { text: string }[];
  expect(prints.at(-1)!.text).toMatch(/TOTAL \(LL\)\s+175,000/);
  expect(prints.at(-1)!.text).toMatch(/Change\s+25,000/);
});

test('US-01: unknown barcode shows an error and adds nothing', async ({ page }) => {
  await scan(page, '0000000000000');
  await expect(page.getByText(/Unknown barcode/i)).toBeVisible();
  await expect(page.getByTestId('cart-row')).toHaveCount(0);
});

test('US-01: scan latency stays under 500 ms with a warm cache', async ({ page }) => {
  await scan(page, TOWEL); // warm
  const t0 = Date.now();
  await scan(page, CHOC);
  await expect(page.getByTestId('cart-row')).toHaveCount(2);
  expect(Date.now() - t0).toBeLessThan(500);
});

test('US-07: hold and recall a cart', async ({ page }) => {
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /Hold/ }).click();
  await expect(page.getByTestId('cart-row')).toHaveCount(0);
  await page.getByRole('button', { name: /Holds/ }).click();
  await page.getByTestId('hold-item').first().getByRole('button', { name: 'Recall' }).click();
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
});

test('US-10: sale made offline is queued and synced exactly once', async ({ page, context }) => {
  await scan(page, TOWEL); // warm: the catalog copy is on this computer before the connection drops
  await page.getByRole('button', { name: /Clear/ }).click();
  const before = (await mySales(page)).length;

  await context.setOffline(true);
  await expect(page.getByText(/Offline/)).toBeVisible();
  await scan(page, TOWEL); // still works: the catalog is local
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/1 pending/)).toBeVisible();
  await expect(page.getByTestId('cart-row')).toHaveCount(0); // the cashier is free to serve the next customer

  await context.setOffline(false);
  await expect(page.getByText(/pending/)).toHaveCount(0, { timeout: 20_000 });

  const after = await mySales(page);
  expect(after.length).toBe(before + 1); // sent once, not twice
  expect(new Set(after.map((s) => s.clientSaleId)).size).toBe(after.length);
});

test('R2: selling an out-of-stock product is never blocked; a low-stock notice is shown', async ({ page }) => {
  await scan(page, '1111111111116'); // seeded with stock 1 and a threshold
  await scan(page, '1111111111116');
  await scan(page, '1111111111116');
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
  await page.keyboard.press('F9');
  await page.getByLabel('Cash LBP').fill('30000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  await expect(page.getByText(/Low stock/i)).toBeVisible(); // non-blocking toast
});

test('R2: low-stock badge on the dashboard opens the list of products to reorder', async ({ page }) => {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Low stock' }).click();
  await expect(page.getByRole('heading', { name: /Low stock/i })).toBeVisible();
  await expect(page.getByTestId('low-stock-row').first()).toBeVisible();
});

test('Q6: pay with Whish, then split OMT + cash', async ({ page }) => {
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByRole('tab', { name: 'Whish' }).click();
  await page.getByLabel('Whish LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();

  await scan(page, CHOC);
  await scan(page, CHOC);
  await page.keyboard.press('F9');
  await page.getByLabel('OMT LBP').fill('60000');
  await page.getByLabel('Cash LBP').fill('40000');
  await expect(page.getByTestId('change-due')).toHaveText(/0/);
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
});

test('Q4: credit sale needs a registered customer; Walk-In is blocked', async ({ page }) => {
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('25000');
  await expect(page.getByText(/Select a registered customer/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete' })).toBeDisabled();

  await page.getByRole('button', { name: 'Customer' }).click();
  await page.getByPlaceholder('Search customer').fill('ahmad');
  await page.getByRole('option', { name: /ahmad darwish/i }).click();
  await expect(page.getByTestId('rest-due')).toHaveText(/50,000/);
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
});

test('Q4: record a payment against a customer account', async ({ page }) => {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Customer accounts' }).click();
  await page
    .getByRole('row', { name: /ahmad darwish/i })
    .getByRole('button', { name: 'Receive payment' })
    .click();
  await page.getByLabel('Amount').fill('5000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Payment recorded/)).toBeVisible();
});

test('US-32: from a customer row, browse the sales behind what they owe', async ({ page }) => {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Customer accounts' }).click();
  const row = page.getByRole('row', { name: /ahmad darwish/i });
  const owes = (await row.locator('td.num').first().textContent())!.trim(); // the figure in the Owes column
  await row.getByRole('button', { name: 'Browse sales of Ahmad Darwish' }).click();

  const dialog = page.getByRole('dialog', { name: /Sales of Ahmad Darwish/ });
  await expect(dialog.getByText(`Owes ${owes}`)).toBeVisible();
  const unpaid = dialog.getByTestId('customer-sale-row');
  expect(await unpaid.count()).toBeGreaterThan(0); // the sale left on account in the test above
  await expect(dialog.getByTestId('debt-total')).toHaveText(owes); // the unpaid sales add up to what they owe

  // a sale opens to what was bought
  await unpaid
    .first()
    .getByRole('button', { name: /Show items of receipt/ })
    .click();
  await expect(dialog.getByRole('list', { name: /Items of receipt/ })).toContainText('Cedars silver towel');

  // all their sales, with a status column
  await dialog.getByLabel('Show').selectOption('all');
  await expect(dialog.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  await expect(dialog.getByTestId('debt-total')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('Q6: closing the register shows expected vs counted for cash, Whish and OMT', async ({ page }) => {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Close register' }).click();
  for (const m of ['Cash', 'Whish', 'OMT']) {
    for (const cur of ['USD', 'LBP']) {
      await expect(page.getByTestId(`expected-${m}-${cur}`)).toBeVisible();
      await expect(page.getByLabel(`${m} ${cur} counted`)).toBeVisible();
    }
  }
});

test('printer failure never blocks the sale', async ({ page }) => {
  await page.route('**/api/v1/sales/*/print', (r) => r.fulfill({ status: 503, body: '{"code":"PRINTER_OFFLINE"}' }));
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry|browser print/i })).toBeVisible();
});

test('keyboard-only: F9 opens payment, Enter completes', async ({ page }) => {
  await scan(page, TOWEL);
  await page.keyboard.press('F9');
  await page.getByLabel('Cash LBP').fill('75000');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
});
