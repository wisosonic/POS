import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// US-06 / US-10 / US-35: finding a sale again, reprinting it, and the sales that have not reached the server yet.
// Same throwaway stack as the other specs (a fake USB printer that records everything it is sent).
const TOWEL = '5287000107945'; // 75,000
const CHOC = '9342390005250'; // 50,000
const PRINTS = '/__e2e/prints';

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

async function sellOne(page: Page, code: string, paid: string) {
  await scan(page, code);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill(paid);
  await page.getByRole('button', { name: 'Complete' }).click();
}

/** The receipt number of the sale just completed, read from the banner. */
async function lastRef(page: Page): Promise<string> {
  const banner = page.getByText(/Sale \d+ completed/);
  await expect(banner).toBeVisible();
  return /Sale (\d+) completed/.exec((await banner.textContent()) ?? '')![1]!;
}

async function openSales(page: Page) {
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Sales', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sales', exact: true })).toBeVisible();
}

const printsFor = async (request: APIRequestContext, ref: string) =>
  ((await (await request.get(PRINTS)).json()).data as { text: string }[]).filter((p) => p.text.includes(`Receipt #${ref}`));

/** Talk to the server directly, as a signed-in user, from outside the browser (so it works while the browser is "offline"). */
async function apiAs(request: APIRequestContext, user: 'cashier' | 'manager' | 'admin') {
  const res = await request.post('/api/v1/auth/login', { data: { username: user, password: `test-${user}-pass` } });
  const token = (await res.json()).accessToken as string;
  const h = { Authorization: `Bearer ${token}` };
  return {
    get: async (path: string) => (await request.get(`/api/v1${path}`, { headers: h })).json(),
    post: (path: string, data: unknown) => request.post(`/api/v1${path}`, { headers: h, data }),
  };
}
async function closeRegister(request: APIRequestContext) {
  const api = await apiAs(request, 'cashier');
  const cur = await api.get('/registers/current');
  const counted = (cur.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
    method: b.method,
    currency: b.currency,
    amount: b.expected,
  }));
  expect((await api.post(`/registers/${cur.id}/close`, { countedBalances: counted })).status()).toBe(200);
}
async function openRegister(request: APIRequestContext) {
  const api = await apiAs(request, 'cashier');
  const openingBalances = ['cash', 'whish', 'omt'].flatMap((method) =>
    (['USD', 'LBP'] as const).map((currency) => ({ method, currency, amount: 0 })),
  );
  expect((await api.post('/registers/open', { terminalId: 'T1', openingBalances })).status()).toBe(201);
}

test('US-06: a sale can be found again and reprinted: the copy says DUPLICATE and does not open the cash drawer', async ({
  page,
  request,
}) => {
  await signIn(page, 'cashier');
  await sellOne(page, CHOC, '50000');
  const ref = await lastRef(page);

  await openSales(page);
  const row = page.getByTestId('sale-row').first();
  await expect(row).toContainText(ref);
  await expect(row).toContainText('50,000 LL');
  await expect(row).toContainText('Paid');
  await row.getByRole('button', { name: `Open receipt ${ref}` }).click();

  const receipt = page.getByTestId('receipt-text');
  await expect(receipt).toContainText(`Receipt #${ref}`);
  await expect(receipt).toContainText('Crispy chocolate'.toUpperCase().slice(0, 0) + 'Crispy chocolate');
  await expect(receipt).not.toContainText('DUPLICATE'); // what is on screen is the receipt as it is

  await page.getByRole('button', { name: 'Print again' }).click();
  await expect.poll(async () => (await printsFor(request, ref)).length).toBe(2); // the one printed at the till, and this copy
  const [original, copy] = await printsFor(request, ref);
  expect(original!.text).not.toContain('DUPLICATE');
  expect(original!.text).toContain('\x1bp'); // the first print opened the drawer for the cash
  expect(copy!.text).toContain('*** DUPLICATE ***');
  expect(copy!.text).not.toContain('\x1bp'); // the copy did not
});

test('US-06: a sale is found by its receipt number; an unknown number, or something that is not a number, says so', async ({ page }) => {
  await signIn(page, 'cashier');
  await sellOne(page, TOWEL, '75000');
  const ref = await lastRef(page);

  await openSales(page);
  await page.getByLabel('Receipt number').fill(ref);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByTestId('sale-row')).toHaveCount(1);
  await expect(page.getByTestId('sale-row')).toContainText('75,000 LL');

  await page.getByLabel('Receipt number').fill('99999999');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('There is no sale of yours with receipt number 99999999.')).toBeVisible();

  await page.getByLabel('Receipt number').fill('abc');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByRole('alert')).toContainText('number printed on the receipt');
});

test('US-14: a cashier sees the return link; a manager goes from the receipt straight into the return', async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page, 'cashier');
  await sellOne(page, CHOC, '50000');
  const ref = await lastRef(page);

  await openSales(page);
  await page.getByRole('button', { name: `Open receipt ${ref}` }).click();
  await expect(page.getByRole('button', { name: /Return items/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Cashier' })).toHaveCount(0); // a cashier's list is their own

  const manager = await (await browser.newContext({ baseURL })).newPage();
  await signIn(manager, 'manager');
  await manager.goto('/sales');
  await expect(manager.getByRole('columnheader', { name: 'Cashier' })).toBeVisible(); // a manager sees who sold
  await manager.getByLabel('Receipt number').fill(ref);
  await manager.getByRole('button', { name: 'Find' }).click();
  await manager.getByRole('button', { name: `Open receipt ${ref}` }).click();
  await manager.getByRole('button', { name: /Return items/ }).click();
  await expect(manager).toHaveURL(new RegExp(`/returns\\?ref=${ref}$`));
  await expect(manager.getByTestId('return-line')).toHaveCount(1); // the sale is already loaded
  await expect(manager.getByText(new RegExp(`Sale ${ref}`))).toBeVisible();
});

test('US-10: a sale made offline is listed as not in the system yet, and disappears into the sales list once sent', async ({
  page,
  context,
}) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL); // warm the catalog copy before the connection drops
  await page.getByRole('button', { name: /Clear/ }).click();
  // A page is fetched the first time it is opened (the built app saves them all for offline use; the test server does not), so
  // visit the Sales page once, and come back to the till, before the connection drops.
  await openSales(page);
  await page.getByRole('button', { name: /Menu/ }).click();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await expect(page.getByTestId('checkout')).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText(/Offline/)).toBeVisible();
  await sellOne(page, TOWEL, '75000');
  await expect(page.getByText(/1 pending/)).toBeVisible();

  await openSales(page); // moving around the app works without the server
  const queued = page.getByTestId('queued-sale');
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText('1 item');
  await expect(queued).toContainText('Cash 75,000 LL');
  await expect(page.getByTestId('not-sent')).toContainText('in no report and not in the register');

  await context.setOffline(false);
  await expect(page.getByTestId('not-sent')).toHaveCount(0, { timeout: 20_000 });
  await page.reload();
  await expect(page.getByTestId('sale-row').first()).toContainText('75,000 LL');
});

test('US-10: a sale the server refuses stays in view with the reason, and Try again sends it once the cause is fixed', async ({
  page,
  context,
  request,
}) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /Clear/ }).click();
  await context.setOffline(true);
  await expect(page.getByText(/Offline/)).toBeVisible();
  await sellOne(page, TOWEL, '75000');
  await expect(page.getByText(/1 pending/)).toBeVisible();

  await closeRegister(request); // while the till was offline, someone closed the register
  await context.setOffline(false);
  await expect(page.getByText(/1 need attention/)).toBeVisible({ timeout: 20_000 });

  await page.goto('/sales');
  const queued = page.getByTestId('queued-sale');
  await expect(queued.getByTestId('queued-reason')).toContainText('The register was closed when this was sent');
  await expect(queued).toContainText('Only a manager can discard a sale.'); // a cashier cannot throw it away
  await expect(queued.getByRole('button', { name: /Discard/ })).toHaveCount(0);

  await openRegister(request); // the cause is fixed
  await queued.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('not-sent')).toHaveCount(0, { timeout: 20_000 });
  await page.reload();
  await expect(page.getByTestId('sale-row').first()).toContainText('75,000 LL');
});

test('US-10: a manager can discard a refused sale, but must say why, and the server keeps a note of it', async ({
  page,
  context,
  request,
}) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL);
  await page.getByRole('button', { name: /Clear/ }).click();
  await context.setOffline(true);
  await expect(page.getByText(/Offline/)).toBeVisible();
  await sellOne(page, TOWEL, '75000');
  await expect(page.getByText(/1 pending/)).toBeVisible();
  await closeRegister(request);
  await context.setOffline(false);
  await expect(page.getByText(/1 need attention/)).toBeVisible({ timeout: 20_000 });

  // the manager signs in at the same till (the waiting sale belongs to the till, not to the cashier)
  await page.goto('/sales');
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Menu/ })).toBeVisible(); // signed in (wait, or the next page load cancels it)
  await page.goto('/sales');

  await page.getByRole('button', { name: /Discard/ }).click();
  await expect(page.getByText('This sale was never recorded.')).toBeVisible(); // it says what discarding means
  await page.getByRole('button', { name: 'Discard the sale' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Say why'); // a reason is required
  await page.getByLabel('Why?').fill('The customer left without paying');
  await page.getByRole('button', { name: 'Discard the sale' }).click();
  await expect(page.getByTestId('not-sent')).toHaveCount(0);

  const admin = await apiAs(request, 'admin');
  const notes = (await admin.get('/audit?action=sale.queued.discard&limit=5')).data as {
    afterJson?: string;
    after?: { reason: string; summary: string };
  }[];
  const text = JSON.stringify(notes);
  expect(text).toContain('The customer left without paying');
  expect(text).toContain('1 item');

  await openRegister(request); // leave the till as the other specs expect it
});

test('US-14 / US-09: a cashier starts a return from the receipt; a manager types their name and password; the goods come back and the money is handed out', async ({
  page,
}) => {
  await signIn(page, 'cashier');
  await sellOne(page, CHOC, '50000');
  const ref = await lastRef(page);

  await openSales(page);
  await page.getByRole('button', { name: `Open receipt ${ref}` }).click();
  await page.getByRole('button', { name: /Return items/ }).click();
  await expect(page).toHaveURL(new RegExp(`/returns\\?ref=${ref}$`));
  await page.getByLabel(/Bringing back/).fill('1');
  await page.getByRole('button', { name: 'Return the items' }).click();

  const dialog = page.getByRole('dialog', { name: 'Manager approval' });
  await expect(dialog).toContainText(`Goods back from sale ${ref}: 50,000 LL`); // what the manager is approving
  await dialog.getByLabel("Manager's name").fill('manager');
  await dialog.getByLabel("Manager's password").fill('wrong-password-here');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); // refused, and nothing was returned
  await expect(page.getByLabel(/Bringing back/)).toBeEnabled(); // nothing came back: it can still be taken back

  await dialog.getByLabel("Manager's password").fill('test-manager-pass');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('region', { name: 'Hand the money back' })).toContainText('Hand back 50,000 LL');
  await page.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.getByText(/Return \d+ recorded/)).toBeVisible();
  await expect(page.getByLabel(/Bringing back/)).toBeDisabled(); // all of it is back now, as the cashier can see
});
