import { test, expect, type Page } from '@playwright/test';

// The Transfers page (docs/15 §4 and §5, P5b and P5c). The e2e stack has no HQ, so the transfer endpoints are stubbed; the test is about what the page asks
// for, what it refuses before asking, and what it shows. The server's own rules are tested in cloud-hq.
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
const requests = [
  {
    id: 4,
    note: 'weekend rush',
    createdAt: '2026-11-28T08:00:00.000Z',
    status: 'open',
    items: [
      { productId: 1, name: 'Palletised rice', wanted: '30', shipped: '20', unavailable: '0', status: 'picking' },
      { productId: 2, name: 'Sugar 1kg', wanted: '10', shipped: '0', unavailable: '10', status: 'done' },
      { productId: 3, name: 'Tea', wanted: '5', shipped: '5', unavailable: '0', status: 'done' },
    ],
  },
];
const pickList = {
  id: 11,
  forBranch: 'Verdun shop',
  requestId: 4,
  note: 'weekend rush',
  openedAt: '2026-11-28T08:05:00.000Z',
  status: 'open',
  items: [
    { productId: 1, name: 'Palletised rice', asked: '30', onHand: '20', shipped: null },
    { productId: 2, name: 'Sugar 1kg', asked: '10', onHand: '0', shipped: null },
  ],
};

async function managerOnTransfers(page: Page, kind: 'sale' | 'stock') {
  const posted: { path: string; body: unknown; key: string | undefined }[] = [];
  const post = (path: string, r: { request(): { postDataJSON(): unknown; headers(): Record<string, string> } }) =>
    posted.push({ path, body: r.request().postDataJSON(), key: r.request().headers()['idempotency-key'] });
  await page.route('**/api/v1/settings/public', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), branchKind: kind } });
  });
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
  await page.route('**/api/v1/pick-lists?**', (r) => r.fulfill({ json: { data: [pickList] } }));
  await page.route('**/api/v1/stock-requests?**', (r) => r.fulfill({ json: { data: requests, nextCursor: null } }));
  await page.route('**/api/v1/shipments?**', (r) => r.fulfill({ json: { data: [], nextCursor: null } }));
  await page.route('**/api/v1/receipts', (r) => {
    post('/receipts', r);
    return r.fulfill({ status: 201, json: { id: 1 } });
  });
  await page.route('**/api/v1/pick-lists/*/fill', (r) => {
    post('/fill', r);
    return r.fulfill({ status: 201, json: { id: 1, shipmentId: 9 } });
  });
  await page.route('**/api/v1/stock-requests', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    post('/stock-requests', r);
    return r.fulfill({ status: 201, json: { id: 5 } });
  });
  await page.route('**/api/v1/shipments', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    post('/shipments', r);
    return r.fulfill({ status: 201, json: { id: 1 } });
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page
      .getByTestId('checkout')
      .or(page.getByRole('button', { name: 'Open register' }))
      .or(page.getByTestId('stock-branch')),
  ).toBeVisible();
  await page.goto('/transfers');
  return posted;
}

test.describe('Transfers (US-HQ-transfers)', () => {
  test('what is on its way is listed; counting it as shipped needs no reason, a different count does', async ({ page }) => {
    const posted = await managerOnTransfers(page, 'sale');
    await page.getByRole('tab', { name: 'Coming in (1)' }).click();
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

  test('a shop can only send back to a stock branch, and must say why', async ({ page }) => {
    const posted = await managerOnTransfers(page, 'sale');
    await page.getByRole('tab', { name: 'Send back' }).click();
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

  test('a shop asks for stock, and follows each line: being picked, not available, shipped', async ({ page }) => {
    const posted = await managerOnTransfers(page, 'sale');
    // what is already asked, and where each line stands
    const progress = page.getByTestId('request-progress');
    await expect(progress).toHaveCount(3);
    await expect(progress.nth(0)).toContainText('A stock branch is picking it');
    await expect(progress.nth(1)).toContainText('10 not available');
    await expect(progress.nth(2)).toContainText('Shipped');
    // a new request
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByTestId('new-request').getByRole('alert')).toContainText('Add at least one product');
    await page.getByLabel('Add a product').fill('tow');
    await page.getByRole('listbox', { name: 'Matching products' }).getByRole('option').first().click();
    await page.getByLabel(/^Quantity of /).fill('12');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText('Requested. HQ will ask the stock branches for it.')).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ path: '/stock-requests', body: { items: [{ qty: '12' }] } });
    expect(posted[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a stock branch picks: each line starts at what is on the shelves, and shipping short says where the rest goes', async ({
    page,
  }) => {
    const posted = await managerOnTransfers(page, 'stock');
    await expect(page.getByRole('tab', { name: 'To pick (1)' })).toBeVisible();
    const card = page.getByTestId('pick-list');
    await expect(card).toContainText('For Verdun shop');
    await expect(page.getByLabel('Ship: Palletised rice')).toHaveValue('20'); // 30 asked, 20 on the shelves
    await expect(page.getByLabel('Ship: Sugar 1kg')).toHaveValue('0'); // none on the shelves
    await expect(card).toContainText('What is shipped short goes to the next stock branch.');
    await page.getByLabel('Ship: Palletised rice').fill('31'); // more than was asked
    await card.getByRole('button', { name: 'Ship it' }).click();
    await expect(card.getByRole('alert')).toContainText('from zero up to what was asked');
    expect(posted).toEqual([]);
    await page.getByLabel('Ship: Palletised rice').fill('20');
    await card.getByRole('button', { name: 'Ship it' }).click();
    await expect(page.getByText('What was shipped has left this branch.')).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      path: '/fill',
      body: {
        items: [
          { productId: 1, shipped: '20' },
          { productId: 2, shipped: '0' }, // EVERY line is answered, even with nothing
        ],
      },
    });
  });

  test('a stock branch may send to a shop as well, with no reason needed', async ({ page }) => {
    await managerOnTransfers(page, 'stock');
    await page.getByRole('tab', { name: 'Send stock' }).click();
    await expect(page.getByLabel('Send to').locator('option')).toHaveText([
      'Choose a branch',
      'Main warehouse (stock branch)',
      'Verdun shop (shop)',
    ]);
    await expect(page.getByText('Note (optional)')).toBeVisible();
  });
});
