import { test, expect, type Page } from '@playwright/test';

// The Transfers page (docs/15 §4, P5b). The e2e stack has no HQ, so the transfer endpoints are stubbed; the test is about what the page asks for,
// what it refuses before asking, and what it shows. The server's own rules are tested in cloud-hq.
const incoming = {
  id: 7,
  fromBranch: 'Main warehouse',
  reason: 'supply',
  note: null,
  shippedAt: '2026-11-28T09:00:00.000Z',
  status: 'on_the_way',
  receivedAt: null,
  items: [
    { productId: 1, name: 'Palletised rice', qty: '30', counted: null, reason: null },
    { productId: 2, name: 'Sugar 1kg', qty: '10', counted: null, reason: null },
  ],
};

async function managerOnTransfers(page: Page, kind: 'sale' | 'stock') {
  const posted: { path: string; body: unknown; key: string | undefined }[] = [];
  await page.route('**/api/v1/transfers/destinations', (r) =>
    r.fulfill({
      json: {
        connected: true,
        kind,
        data: [
          { id: 2, code: 'WH', name: 'Main warehouse', kind: 'stock', allowed: true },
          { id: 3, code: 'SB', name: 'Verdun shop', kind: 'sale', allowed: kind === 'stock' },
        ],
      },
    }),
  );
  await page.route('**/api/v1/incoming?**', (r) =>
    r.fulfill({ json: { data: r.request().url().includes('status=received') ? [] : [incoming] } }),
  );
  await page.route('**/api/v1/shipments?**', (r) => r.fulfill({ json: { data: [], nextCursor: null } }));
  await page.route('**/api/v1/receipts', (r) => {
    posted.push({ path: '/receipts', body: r.request().postDataJSON(), key: r.request().headers()['idempotency-key'] });
    return r.fulfill({ status: 201, json: { id: 1 } });
  });
  await page.route('**/api/v1/shipments', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    posted.push({ path: '/shipments', body: r.request().postDataJSON(), key: r.request().headers()['idempotency-key'] });
    return r.fulfill({ status: 201, json: { id: 1 } });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/transfers');
  return posted;
}

test.describe('Transfers (US-HQ-transfers)', () => {
  test('what is on its way is listed; counting it as shipped needs no reason, a different count does', async ({ page }) => {
    const posted = await managerOnTransfers(page, 'sale');
    await expect(page.getByRole('tab', { name: 'Coming in (1)' })).toBeVisible();
    const card = page.getByTestId('incoming');
    await expect(card).toContainText('From Main warehouse');
    await expect(card).toContainText('30 × Palletised rice');
    await card.getByRole('button', { name: /Confirm what arrived/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm what arrived' });
    await expect(dialog.getByTestId('receive-line')).toHaveCount(2);
    // a different count asks for its reason, and nothing is sent without it
    await dialog.getByLabel('Counted: Palletised rice').fill('28');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Say why the count of Palletised rice differs');
    expect(posted).toEqual([]);
    await dialog.getByLabel('Why it differs: Palletised rice').fill('2 bags torn');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('The stock is in.')).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      path: '/receipts',
      body: { incomingId: 7, items: [{ productId: 1, counted: '28', reason: '2 bags torn' }] }, // only the line that differs
    });
    expect(posted[0]!.key).toMatch(/^[0-9a-f-]{36}$/); // one request id, so a repeat can never count twice
  });

  test('a shop can only send to a stock branch, and must say why', async ({ page }) => {
    const posted = await managerOnTransfers(page, 'sale');
    await page.getByRole('tab', { name: /Send stock/ }).click();
    const select = page.getByLabel('Send to');
    await expect(select.locator('option')).toHaveText(['Choose a branch', 'Main warehouse (stock branch)']); // not the other shop
    await select.selectOption({ label: 'Main warehouse (stock branch)' });
    await page.getByLabel('Add a product').fill('tow');
    await page.getByRole('listbox', { name: 'Matching products' }).getByRole('option').first().click();
    await expect(page.getByTestId('send-line')).toHaveCount(1);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Say why the stock is going back');
    expect(posted).toEqual([]);
    await page.getByLabel('Why is it going back?').fill('slow here, busy at Verdun');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Sent to Main warehouse/)).toBeVisible();
    expect(posted[0]).toMatchObject({
      path: '/shipments',
      body: { toBranchId: 2, note: 'slow here, busy at Verdun', items: [{ qty: '1' }] },
    });
    await expect(page.getByTestId('send-line')).toHaveCount(0); // the form is empty again
  });

  test('a stock branch may send to a shop as well, with no reason needed', async ({ page }) => {
    await managerOnTransfers(page, 'stock');
    await page.getByRole('tab', { name: /Send stock/ }).click();
    await expect(page.getByLabel('Send to').locator('option')).toHaveText([
      'Choose a branch',
      'Main warehouse (stock branch)',
      'Verdun shop (shop)',
    ]);
    await expect(page.getByText('Note (optional)')).toBeVisible();
  });
});
