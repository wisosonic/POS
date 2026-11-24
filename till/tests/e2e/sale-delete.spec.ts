import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// US-14c (QUESTIONS.md #8, option C): a cancelled sale, or a sale that has had items taken back, can be deleted for good. A cashier
// needs a manager's approval; a manager does not. Same throwaway stack as the other specs.
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
async function sellTowel(page: Page): Promise<string> {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(TOWEL, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  const banner = page.getByText(/Sale \d+ completed/);
  await expect(banner).toBeVisible();
  return /Sale (\d+) completed/.exec((await banner.textContent()) ?? '')![1]!;
}
async function managerHeaders(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: 'test-manager-pass' } });
  return { Authorization: `Bearer ${(await login.json()).accessToken}` };
}
/** Cancel (void) or take the towel back, as the manager, through the API: the screen test is about the deleting. */
async function viaApi(request: APIRequestContext, ref: string, what: 'void' | 'return') {
  const h = await managerHeaders(request);
  const sale = await (await request.get(`/api/v1/sales/by-ref/${ref}`, { headers: h })).json();
  const res =
    what === 'void'
      ? await request.post(`/api/v1/sales/${sale.id}/void`, { headers: { ...h, 'Idempotency-Key': randomUUID() }, data: { reason: 'e2e' } })
      : await request.post('/api/v1/returns', {
          headers: { ...h, 'Idempotency-Key': randomUUID() },
          data: {
            saleId: sale.id,
            items: [{ saleItemId: sale.items[0].id, qty: '1' }],
            reason: 'e2e',
            refund: { method: 'cash', currency: 'LBP', amount: 75000 },
          },
        });
  expect(res.status()).toBeLessThan(300);
}
const openReceipt = async (page: Page, ref: string) => {
  await page.goto('/sales');
  await page.getByRole('button', { name: `Open receipt ${ref}` }).click();
};

test('US-14c: a cashier deletes a cancelled sale for good: a reason, the word DELETE, then the manager approves', async ({
  page,
  request,
}) => {
  await signIn(page, 'cashier');
  const ref = await sellTowel(page);
  await viaApi(request, ref, 'void');

  await openReceipt(page, ref);
  await page.getByRole('button', { name: /Delete for good/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this sale' });
  await expect(dialog).toContainText('This cannot be undone');
  await dialog.getByRole('button', { name: 'Delete it for good' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Say why'); // a reason is required
  await dialog.getByLabel('Why?').fill('Rang up by mistake');
  await dialog.getByRole('button', { name: 'Delete it for good' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Type DELETE'); // and the word
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete it for good' }).click();

  // a cashier cannot do it alone: the manager types their own name and password, for this sale
  await expect(dialog).toContainText(`Delete sale ${ref} for good: 75,000 LL`);
  await dialog.getByLabel("Manager's name").fill('manager');
  await dialog.getByLabel("Manager's password").fill('wrong-password-here');
  await dialog.getByRole('button', { name: 'Approve and delete' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel("Manager's password").fill('test-manager-pass');
  await dialog.getByRole('button', { name: 'Approve and delete' }).click();
  await expect(page.getByText(`Sale ${ref} was deleted`)).toBeVisible();

  // it is gone from the list, and from a look-up by its receipt number
  await expect(page.getByTestId('sale-row').filter({ hasText: new RegExp(`^${ref}\\b`) })).toHaveCount(0);
  const h = await managerHeaders(request);
  expect((await request.get(`/api/v1/sales/by-ref/${ref}`, { headers: h })).status()).toBe(404);
});

test('US-14c: a sale that has had items taken back can be deleted too, and the stock goes back with it', async ({ page, request }) => {
  await signIn(page, 'cashier');
  const h = await managerHeaders(request);
  const stockOf = async () => {
    const found = (await (await request.get(`/api/v1/products/by-barcode/${TOWEL}`, { headers: h })).json()).data[0] as { id: number };
    return Number((await (await request.get(`/api/v1/stock?productId=${found.id}`, { headers: h })).json()).data[0].qty);
  };
  const before = await stockOf();
  const ref = await sellTowel(page);
  await viaApi(request, ref, 'return'); // the only towel came back: the shelf is as it was
  expect(await stockOf()).toBe(before);

  await openReceipt(page, ref);
  await page.getByRole('button', { name: /Delete for good/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this sale' });
  await expect(dialog).toContainText('as if neither had happened'); // a sale with returns says what changes
  await dialog.getByLabel('Why?').fill('Customer changed their mind and the receipt was wrong');
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete it for good' }).click();
  await dialog.getByLabel("Manager's name").fill('manager');
  await dialog.getByLabel("Manager's password").fill('test-manager-pass');
  await dialog.getByRole('button', { name: 'Approve and delete' }).click();
  await expect(page.getByText(`Sale ${ref} was deleted`)).toBeVisible();
  expect(await stockOf()).toBe(before); // sale and return both removed: nothing left to change the shelf
  expect((await request.get(`/api/v1/sales/by-ref/${ref}`, { headers: h })).status()).toBe(404);
});

test('US-14c: a manager deletes without anyone approving; an ordinary sale has no delete button', async ({ page, request }) => {
  await signIn(page, 'manager');
  const ordinary = await sellTowel(page);
  await openReceipt(page, ordinary);
  await expect(page.getByRole('button', { name: /Cancel this sale/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete for good/ })).toHaveCount(0); // not cancelled, nothing taken back
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await viaApi(request, ordinary, 'void');
  await openReceipt(page, ordinary);
  await page.getByRole('button', { name: /Delete for good/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this sale' });
  await dialog.getByLabel('Why?').fill('Test sale');
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete it for good' }).click();
  await expect(page.getByText(`Sale ${ordinary} was deleted`)).toBeVisible(); // no approval step for a manager
});
