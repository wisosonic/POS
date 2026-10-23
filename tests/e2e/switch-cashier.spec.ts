import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// US-25: handing the till to another cashier with a PIN. Same throwaway stack as the other specs.
const TOWEL = '5287000107945';

async function adminApi(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'test-admin-pass' } });
  const h = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  return {
    get: async (path: string) => (await request.get(`/api/v1${path}`, { headers: h })).json(),
    post: (path: string, data: unknown) => request.post(`/api/v1${path}`, { headers: h, data }),
    patch: (path: string, data: unknown) => request.patch(`/api/v1${path}`, { headers: h, data }),
  };
}

async function signInCashier(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}

test('US-25: a cashier hands the till to another with a PIN; the cart stays, and a wrong PIN is refused', async ({ page, request }) => {
  const admin = await adminApi(request);
  const made = await admin.post('/users', { username: 'rima', name: 'Rima', role: 'cashier', password: 'rima-password-1', pin: '2468' });
  expect(made.status()).toBe(201);

  await signInCashier(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(TOWEL, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-row')).toHaveCount(1);

  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: 'Switch cashier' }).click();
  const dialog = page.getByRole('dialog', { name: 'Switch cashier' });
  await expect(dialog.getByRole('button', { name: 'Rima' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Test cashier' })).toHaveCount(0); // not yourself
  await dialog.getByRole('button', { name: 'Rima' }).click();

  for (const d of '1357') await dialog.getByRole('button', { name: d, exact: true }).click(); // the keypad
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Wrong PIN');
  await expect(dialog.getByLabel('PIN', { exact: true })).toHaveValue(''); // cleared for the next try

  await dialog.getByLabel('PIN', { exact: true }).fill('2468');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Rima is signed in')).toBeVisible();
  await expect(page.getByTestId('cart-row')).toHaveCount(1); // the cart belongs to the till

  await page.getByRole('button', { name: 'Account: Rima' }).click();
  await expect(page.getByRole('button', { name: 'Sign out (Rima)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Menu/ }).click();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0); // still a cashier

  // she can sell, and the sale is hers
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('75000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
  const sales = (await admin.get('/sales?limit=1')).data as { userName: string }[];
  expect(sales[0]!.userName).toBe('Rima');
});

test('US-25: with no other PIN holder the dialog says so, and a manager cannot be switched to', async ({ page, request }) => {
  const admin = await adminApi(request);
  // a manager cannot even have a PIN (the server refuses), so the list can never offer one
  const users = (await admin.get('/users')).data as { id: number; username: string; role: string }[];
  const manager = users.find((u) => u.role === 'manager')!;
  expect((await admin.patch(`/users/${manager.id}`, { pin: '1234' })).status()).toBe(422);
  const list = (await admin.get('/users/pin-list')).data as { name: string }[];
  expect(list.map((p) => p.name)).not.toContain('Test manager');

  await signInCashier(page);
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: 'Switch cashier' }).click();
  await expect(page.getByRole('dialog', { name: 'Switch cashier' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
