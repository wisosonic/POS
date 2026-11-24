import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// US-18: counting the shelf from the manager's screen. Same throwaway stack as the other specs.
const TOWEL = '5287000107945';

async function managerAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}
async function headers(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: 'test-manager-pass' } });
  return { Authorization: `Bearer ${(await login.json()).accessToken}` };
}
/** Other specs sell the towel down (stock may be anything, even negative): put plenty on the shelf so a count can be made from it. */
async function stockUp(request: APIRequestContext, barcode: string) {
  const h = await headers(request);
  const found = (await (await request.get(`/api/v1/products/by-barcode/${barcode}`, { headers: h })).json()).data[0] as {
    id: number;
    qty: string;
  };
  await request.post('/api/v1/stock/adjustments', {
    headers: h,
    data: { productId: found.id, qtyDelta: String(60 - Number(found.qty)), reason: 'e2e: plenty on the shelf' },
  });
}
async function onHand(request: APIRequestContext, barcode: string): Promise<number> {
  const h = await headers(request);
  const found = (await (await request.get(`/api/v1/products/by-barcode/${barcode}`, { headers: h })).json()).data[0] as { id: number };
  const stock = await (await request.get(`/api/v1/stock?productId=${found.id}`, { headers: h })).json();
  return Number(stock.data[0].qty);
}

test('US-18: a manager counts products, sees the differences, finishes, and only the differences change', async ({ page, request }) => {
  await stockUp(request, TOWEL);
  const before = await onHand(request, TOWEL);
  await managerAt(page, '/stocktake');
  await page.getByLabel(/Name of this count/).fill('Aisle 1');
  await page.getByRole('button', { name: 'Start a count' }).click();
  await expect(page.getByRole('heading', { name: 'Count' })).toContainText('Aisle 1');
  await expect(page.getByText('Nothing counted yet')).toBeVisible();

  // three scans of the towel, one by name
  for (let i = 0; i < 3; i++) {
    await page.getByLabel(/Scan a barcode/).fill(TOWEL);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('count-message')).toContainText(`counted ${i + 1}`);
  }
  await page.getByLabel(/Scan a barcode/).fill('Crispy');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('count-line')).toHaveCount(2);

  const towelLine = page.getByTestId('count-line').filter({ hasText: 'towel' });
  const gap = 3 - before; // counted 3 against what the system held (earlier tests may have left it anywhere)
  await expect(towelLine.getByTestId('difference')).toHaveText(gap > 0 ? `+${gap}` : String(gap));
  const counted = towelLine.getByLabel(/Counted:/);
  await counted.fill(String(before - 2));
  await counted.press('Enter');
  await expect(page.getByTestId('count-line').filter({ hasText: 'towel' }).getByTestId('difference')).toHaveText('-2');

  await page.getByRole('button', { name: 'Finish and adjust stock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Finish the count' });
  await expect(dialog).toContainText('differ from the system');
  await dialog.getByRole('button', { name: 'Keep counting' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish and adjust stock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finish and adjust' }).click();
  await expect(page.getByText(/Finished: \d+ products? adjusted/)).toBeVisible();

  expect(await onHand(request, TOWEL)).toBe(before - 2);
  await expect(page.getByText('This count is finished')).toBeVisible();
  await expect(page.getByLabel(/Scan a barcode/)).toHaveCount(0); // history: nothing can be changed
  await expect(page.getByRole('button', { name: 'Finish and adjust stock' })).toHaveCount(0);

  await page.goto('/stocktake');
  await expect(page.getByTestId('count-row').first()).toContainText('Finished');
});

test('US-18: a count can be cancelled and changes nothing; a name that matches nothing says so; cashiers have no Stocktake', async ({
  page,
  request,
}) => {
  const before = await onHand(request, TOWEL);
  await managerAt(page, '/stocktake');
  await page.getByRole('button', { name: 'Start a count' }).click();
  await page.getByLabel(/Scan a barcode/).fill('zzzz-nothing-like-this');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('count-message')).toContainText('Nothing found');
  await page.getByLabel(/Scan a barcode/).fill(TOWEL);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('count-line')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel this count' }).click();
  await expect(page.getByRole('heading', { name: 'Stocktake' })).toBeVisible();
  await expect(page.getByTestId('count-row').first()).toContainText('Cancelled');
  expect(await onHand(request, TOWEL)).toBe(before);

  const cashier = await page
    .context()
    .browser()!
    .newContext({ baseURL: page.url().split('/stocktake')[0] });
  const p = await cashier.newPage();
  await p.goto('/login');
  await p.getByLabel('Username').fill('cashier');
  await p.getByLabel('Password').fill('test-cashier-pass');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('button', { name: /Menu/ })).toBeVisible();
  await p.goto('/stocktake');
  await expect(p.getByRole('heading', { name: 'Stocktake' })).toHaveCount(0);
  await cashier.close();
});

test('US-18: a count is deleted from the list after a confirmation, and the stock it changed stays changed', async ({ page, request }) => {
  await stockUp(request, TOWEL);
  const before = await onHand(request, TOWEL);
  await managerAt(page, '/stocktake');

  // a finished count: counted 2 more than the system holds
  await page.getByLabel(/Name of this count/).fill('Doomed count');
  await page.getByRole('button', { name: 'Start a count' }).click();
  await page.getByLabel(/Scan a barcode/).fill(TOWEL);
  await page.keyboard.press('Enter');
  const counted = page.getByTestId('count-line').getByLabel(/Counted:/);
  await counted.fill(String(before + 2));
  await counted.press('Enter');
  await page.getByRole('button', { name: 'Finish and adjust stock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finish and adjust' }).click();
  await expect(page.getByText(/Finished: \d+ products? adjusted/)).toBeVisible();
  expect(await onHand(request, TOWEL)).toBe(before + 2);

  await page.goto('/stocktake');
  const row = page.getByTestId('count-row').filter({ hasText: 'Doomed count' });
  await expect(row).toContainText('Finished');

  // Cancel keeps it
  await row.getByRole('button', { name: /^Delete / }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete count' });
  await expect(dialog).toContainText('stay in each product');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toBeVisible();

  // Delete removes it from the list, and the quantity stays as the count left it
  await row.getByRole('button', { name: /^Delete / }).click();
  await page.getByRole('dialog', { name: 'Delete count' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(await onHand(request, TOWEL)).toBe(before + 2);

  // a count that is still being made is cancelled and removed in one step
  await page.getByLabel(/Name of this count/).fill('Half done');
  await page.getByRole('button', { name: 'Start a count' }).click();
  await page.goto('/stocktake');
  const open = page.getByTestId('count-row').filter({ hasText: 'Half done' });
  await expect(open).toContainText('Counting');
  await open.getByRole('button', { name: /^Delete / }).click();
  await expect(page.getByRole('dialog', { name: 'Delete count' })).toContainText('not finished');
  await page.getByRole('dialog', { name: 'Delete count' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(open).toHaveCount(0);
});
