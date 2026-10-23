import { test, expect, type Page } from '@playwright/test';

// US-09: discounts at the till. Within the cashier's limit (10%) it applies at once; above it a manager types their own
// name and password and sees what they approve; the approval covers that discount and nothing more.
const TOWEL = '5287000107945'; // 75,000
const CHOC = '9342390005250'; // 50,000  → cart of both = 125,000

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

const total = async (page: Page) => Number(((await page.getByTestId('cart-total').textContent()) ?? '').replace(/[^\d]/g, ''));

async function cartOf125(page: Page) {
  await scan(page, TOWEL);
  await scan(page, CHOC);
  await expect(page.getByTestId('cart-total')).toHaveText(/125,000/);
}

async function openDiscount(page: Page) {
  await page.getByRole('button', { name: 'Discount (F6)' }).click();
  await expect(page.getByRole('dialog', { name: 'Discount' })).toBeVisible();
}

async function payAndComplete(page: Page) {
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('200000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
}

/** The newest sale as the server stored it. The browser holds the session as a cookie, so trade it for a token first. */
async function newestSale(page: Page) {
  const { accessToken } = await (await page.request.post('/api/v1/auth/refresh')).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const list = await (await page.request.get('/api/v1/sales?limit=1', { headers: auth })).json();
  return (await page.request.get(`/api/v1/sales/${list.data[0].id}`, { headers: auth })).json();
}

test('US-09: a discount within the limit applies at once and is on the sale', async ({ page }) => {
  await signIn(page, 'cashier');
  await cartOf125(page);
  await openDiscount(page);
  await page.getByRole('button', { name: '5%', exact: true }).click();
  await expect(page.getByTestId('discount-preview')).toHaveText('−6,250 LL');
  await expect(page.getByText(/You can give up to \d+% yourself/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByTestId('discount-row')).toContainText('−6,250 LL');
  await expect(page.getByTestId('discount-row')).not.toContainText('approved by');
  expect(await total(page)).toBeLessThan(125000);

  await payAndComplete(page);
  const sale = await newestSale(page);
  expect(sale.discountLbp).toBe(6250);
  expect(sale.subtotalLbp).toBe(125000);
});

test('US-09: above the limit a manager must approve; a wrong password is refused; the right one lets the sale through', async ({
  page,
}) => {
  await signIn(page, 'cashier');
  await cartOf125(page);
  await openDiscount(page);
  await page.getByLabel('Percent off the whole cart').fill('25');
  await expect(page.getByText(/A manager has to approve this one/)).toBeVisible();
  await page.getByRole('button', { name: 'Ask a manager' }).click();

  // the manager is shown exactly what they approve
  await expect(page.getByText('25% off')).toBeVisible();
  await page.getByLabel("Manager's name").fill('manager');
  await page.getByLabel("Manager's password").fill('not-the-password');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  await expect(page.getByTestId('discount-row')).toHaveCount(0); // nothing was applied

  // a cashier's own password is not a manager's
  await page.getByLabel("Manager's name").fill('cashier');
  await page.getByLabel("Manager's password").fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toContainText('not accepted');

  await page.getByLabel("Manager's name").fill('manager');
  await page.getByLabel("Manager's password").fill('test-manager-pass');
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect(page.getByTestId('discount-row')).toContainText('−31,250 LL');
  await expect(page.getByTestId('discount-row')).toContainText('approved by Test manager');

  await payAndComplete(page);
  const sale = await newestSale(page);
  expect(sale.discountLbp).toBe(31250);
});

test('US-09: when the cart changes so the approval no longer covers the discount, it is withdrawn and the till asks again before paying', async ({
  page,
}) => {
  await signIn(page, 'cashier');
  await cartOf125(page);
  await openDiscount(page);
  await page.getByRole('tab', { name: 'Amount (LL)' }).click();
  await page.getByLabel('Lira off the whole cart').fill('31,250'); // 25% of 125,000
  await page.getByRole('button', { name: 'Ask a manager' }).click();
  await page.getByLabel("Manager's name").fill('manager');
  await page.getByLabel("Manager's password").fill('test-manager-pass');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('discount-row')).toContainText('approved by');

  // taking the towel out makes the same 31,250 worth 62.5% of what is left: more than the manager saw
  await page.getByRole('button', { name: /Remove Cedars silver towel/ }).click();
  await expect(page.getByText(/no longer covers the discount/)).toBeVisible();
  await expect(page.getByTestId('discount-row')).not.toContainText('approved by');

  await page.getByRole('button', { name: /PAY/ }).click();
  await expect(page.getByRole('dialog', { name: 'Discount' })).toBeVisible(); // not the payment: ask again first
  await expect(page.getByRole('dialog', { name: 'Payment' })).toHaveCount(0);
});

test('US-09: a discount bigger than the cart is refused, and a discount can be changed or removed', async ({ page }) => {
  await signIn(page, 'cashier');
  await scan(page, CHOC);
  await openDiscount(page);
  await page.getByRole('tab', { name: 'Amount (LL)' }).click();
  await page.getByLabel('Lira off the whole cart').fill('60,000'); // the cart is worth 50,000
  await expect(page.getByRole('alert')).toContainText('more than the cart is worth');
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await page.getByLabel('Lira off the whole cart').fill('2,000');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('discount-row')).toContainText('−2,000 LL');

  await page.getByRole('button', { name: 'Change the discount' }).click();
  await page.getByRole('tab', { name: 'Percent (%)' }).click();
  await page.getByLabel('Percent off the whole cart').fill('10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('discount-row')).toContainText('−5,000 LL');

  await page.getByRole('button', { name: 'Remove the discount' }).click();
  await expect(page.getByTestId('discount-row')).toHaveCount(0);
  await expect(page.getByTestId('cart-total')).toHaveText(/50,000/);
});

test('US-09: a manager gives any discount without asking anyone', async ({ page }) => {
  await signIn(page, 'manager');
  await cartOf125(page);
  await openDiscount(page);
  await page.getByLabel('Percent off the whole cart').fill('50');
  await expect(page.getByText(/A manager has to approve/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply' }).click(); // no "Ask a manager" step
  await expect(page.getByTestId('discount-row')).toContainText('−62,500 LL');
  await expect(page.getByTestId('discount-row')).not.toContainText('approved by');

  await payAndComplete(page);
  expect((await newestSale(page)).discountLbp).toBe(62500);
});

test('US-09: the F6 key opens the discount, and a held cart does not keep it (and says so)', async ({ page }) => {
  await signIn(page, 'cashier');
  await scan(page, TOWEL);
  await page.keyboard.press('F6');
  await expect(page.getByRole('dialog', { name: 'Discount' })).toBeVisible();
  await page.getByRole('button', { name: '5%', exact: true }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('discount-row')).toBeVisible();

  await page.getByRole('button', { name: /Hold/ }).click();
  await expect(page.getByText(/discount is not kept with a held cart/i)).toBeVisible();
  await expect(page.getByTestId('discount-row')).toHaveCount(0);
});
