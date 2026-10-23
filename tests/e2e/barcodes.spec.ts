import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// US-34: cleaning up duplicate barcodes from the manager's screen. Same throwaway stack as the other specs.
async function managerApi(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { username: 'manager', password: 'test-manager-pass' } });
  const h = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  return {
    get: async (path: string) => (await request.get(`/api/v1${path}`, { headers: h })).json(),
    post: (path: string, data: unknown) => request.post(`/api/v1${path}`, { headers: h, data }),
    patch: (path: string, data: unknown) => request.patch(`/api/v1${path}`, { headers: h, data }),
  };
}
async function managerAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

test('US-34: shared barcodes are listed; one product gets a new barcode, the others are folded into one; then the rule is turned on', async ({
  page,
  request,
}) => {
  const api = await managerApi(request);
  const make = async (name: string, barcode: string) =>
    (await (await api.post('/products', { name, barcode, priceMinor: 10000 })).json()).id as number;
  const a = await make('Dup alpha', '8810000000011');
  await make('Dup beta', '8810000000011');
  await make('Pair one', '8810000000028');
  await make('Pair two', '8810000000028');
  await make('Pair three', '8810000000028');
  await api.post('/stock/adjustments', { productId: a, qtyDelta: '5', reason: 'e2e' });

  await managerAt(page, '/barcodes');
  const groups = page.getByTestId('barcode-group');
  await expect(page.getByTestId('barcode-status')).toContainText('are shared by');
  const first = groups.filter({ hasText: '8810000000011' });
  await expect(first.getByTestId('barcode-product')).toHaveCount(2);
  await expect(first.getByTestId('barcode-product').first()).toContainText('5'); // its stock helps to choose

  // give "Dup beta" its own barcode
  await first.getByRole('button', { name: 'New barcode for Dup beta' }).click();
  const recode = page.getByRole('dialog', { name: 'New barcode' });
  await recode.getByLabel(/Barcode/).fill('8810000000035');
  await recode.getByRole('button', { name: 'Save' }).click();
  await expect(groups.filter({ hasText: '8810000000011' })).toHaveCount(0);

  // fold the three into one
  const pairs = groups.filter({ hasText: '8810000000028' });
  await expect(pairs.getByTestId('barcode-product')).toHaveCount(3);
  await pairs.getByRole('button', { name: /Keep Pair one and fold/ }).click();
  const merge = page.getByRole('dialog', { name: 'Keep this product' });
  await expect(merge).toContainText('Pair two, Pair three will be hidden');
  await merge.getByRole('button', { name: 'Fold them into this one' }).click();
  await expect(page.getByText('2 products folded into Pair one')).toBeVisible();

  // only the old data's own duplicates may remain; clean them if there are any in this database
  const left = (await api.get('/barcodes/status')) as { duplicateGroups: number };
  expect(left.duplicateGroups).toBe(0);
  await expect(page.getByTestId('barcode-status')).toContainText('No barcode is shared');
  await page.getByRole('button', { name: 'Turn the rule on' }).click();
  await expect(page.getByTestId('barcode-status')).toContainText('The rule is on');

  // and it holds
  const dup = await api.post('/products', { name: 'Copycat', barcode: '8810000000035', priceMinor: 1 });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).code).toBe('DUPLICATE_BARCODE');

  // put the switch back so the other specs may create what they like
  const admin = await request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'test-admin-pass' } });
  const off = await request.post('/api/v1/barcodes/enforce', {
    headers: { Authorization: `Bearer ${(await admin.json()).accessToken}` },
    data: { enabled: false },
  });
  expect(off.status()).toBe(200);
});

test('US-34: a cashier has no Duplicate barcodes page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Menu/ })).toBeVisible();
  await page.goto('/barcodes');
  await expect(page.getByRole('heading', { name: 'Duplicate barcodes' })).toHaveCount(0);
});
