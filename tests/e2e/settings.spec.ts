import { test, expect, type Page } from '@playwright/test';

// The admin sets the exchange rate and the shop details, and checks the printer. Other specs rely on 90,000 and the shop
// name, so each test puts back what it changed.
async function adminAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('test-admin-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click(); // the till's dialog covers the header until the register is open
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
  await page.goto(path);
}

test('the admin changes the exchange rate; a likely typo has to be confirmed; the rate can be put back', async ({ page }) => {
  await adminAt(page, '/settings/rate');
  await expect(page.getByTestId('current-rate')).toHaveText('1$ = 90,000 LL');
  const rows = await page.getByTestId('rate-row').count();

  await page.getByLabel('New rate').fill('91,000');
  await page.getByRole('button', { name: 'Set the rate' }).click();
  await expect(page.getByTestId('current-rate')).toHaveText('1$ = 91,000 LL');
  await expect(page.getByTestId('rate-row')).toHaveCount(rows + 1);
  await expect(page.getByTestId('rate-row').first()).toContainText('In force');

  // an extra zero is almost certainly a mistake: the admin is asked, and saying no saves nothing
  page.once('dialog', (d) => {
    expect(d.message()).toContain('91,000');
    expect(d.message()).toContain('910,000');
    void d.dismiss();
  });
  await page.getByLabel('New rate').fill('910,000');
  await page.getByRole('button', { name: 'Set the rate' }).click();
  await expect(page.getByTestId('rate-row')).toHaveCount(rows + 1);
  await expect(page.getByTestId('current-rate')).toHaveText('1$ = 91,000 LL');

  await page.getByLabel('New rate').fill('abc');
  await page.getByRole('button', { name: 'Set the rate' }).click();
  await expect(page.getByRole('alert')).toContainText('how many lira one dollar is worth');

  // a rate that starts later is saved but not in force yet
  await page.getByLabel('Start it later').check();
  await page.getByLabel('New rate').fill('92,000');
  await page.getByLabel('Starts at').fill('2999-01-01T09:00');
  await page.getByRole('button', { name: 'Set the rate' }).click();
  await expect(page.getByTestId('rate-row').filter({ hasText: 'Not in force yet' })).toHaveCount(1);
  await expect(page.getByTestId('current-rate')).toHaveText('1$ = 91,000 LL');

  await page.getByLabel('Start it later').uncheck();
  await page.getByLabel('New rate').fill('90,000');
  await page.getByRole('button', { name: 'Set the rate' }).click();
  await expect(page.getByTestId('current-rate')).toHaveText('1$ = 90,000 LL');
});

test('the admin changes the shop details, and the test slip reaches the printer', async ({ page, request }) => {
  await adminAt(page, '/settings/shop');
  await expect(page.getByLabel(/^Name/)).toHaveValue('Darwish Market');

  // a width the printer cannot have is refused with a reason
  await page.getByLabel('Receipt width').fill('5');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert')).toContainText('between 20 and 80');
  await page.getByLabel('Receipt width').fill('42');

  await page.getByLabel(/^Name/).fill('Darwish Market Hamra');
  await page.getByLabel('Line at the bottom').fill('Thank you, see you soon');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('link', { name: 'Darwish Market Hamra' })).toBeVisible(); // the header follows at once

  // the test slip goes to the saved printer, so changing the box turns the button off until it is saved
  await page.getByLabel('Printer name').fill('Another printer');
  await expect(page.getByRole('button', { name: 'Print a test slip' })).toBeDisabled();
  await expect(page.getByText('Save first')).toBeVisible();
  await page.getByLabel('Printer name').fill('E2E Printer');
  await expect(page.getByRole('button', { name: 'Print a test slip' })).toBeEnabled();

  await page.getByRole('button', { name: 'Print a test slip' }).click();
  await expect(page.getByText('Test slip sent to the printer')).toBeVisible();
  const prints = (await (await request.get('/__e2e/prints')).json()).data as { text: string }[];
  const slip = prints.at(-1)!.text;
  expect(slip).toContain('TEST PRINT');
  expect(slip).toContain('DARWISH MARKET HAMRA');

  // put the name back
  await page.getByLabel(/^Name/).fill('Darwish Market');
  await page.getByLabel('Line at the bottom').fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('link', { name: 'Darwish Market', exact: true })).toBeVisible();
});

test('the gear opens Settings with a side menu: the admin has every section, a manager only Appearance; the header shows no rate', async ({
  page,
  browser,
  baseURL,
}) => {
  await adminAt(page, '/');
  await expect(page.getByText(/1\$ = /)).toHaveCount(0); // not in the header any more
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); // the gear
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  const menu = page.getByRole('navigation', { name: 'Settings' });
  for (const name of ['Appearance', 'Shop and receipts', 'Exchange rate', 'Users', 'Backups'])
    await expect(menu.getByRole('link', { name })).toBeVisible();
  await menu.getByRole('link', { name: 'Exchange rate' }).click();
  await expect(page).toHaveURL(/\/settings\/rate$/);
  await expect(menu.getByRole('link', { name: 'Exchange rate' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/settings/shop');
  await expect(page.getByRole('heading', { name: 'Shop and receipts' })).toBeVisible();
  for (const old of ['/rate', '/users', '/backups']) {
    const now = old.slice(1);
    await page.goto(old); // the old addresses still lead there
    await expect(page).toHaveURL(new RegExp(`/settings/${now}$`));
  }

  const other = await (await browser.newContext({ baseURL })).newPage();
  await other.goto('/login');
  await other.getByLabel('Username').fill('manager');
  await other.getByLabel('Password').fill('test-manager-pass');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByTestId('checkout').or(other.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await expect(other.getByText(/1\$ = /)).toHaveCount(0);
  await other.getByRole('link', { name: 'Settings', exact: true }).click(); // everyone has the gear: Appearance is for everyone
  const otherMenu = other.getByRole('navigation', { name: 'Settings' });
  await expect(otherMenu.getByRole('link')).toHaveCount(1);
  await expect(otherMenu.getByRole('link', { name: 'Appearance' })).toBeVisible();
  for (const path of ['/settings/shop', '/settings/rate', '/settings/users', '/settings/backups', '/rate', '/users']) {
    await other.goto(path);
    await expect(other).toHaveURL(/\/settings\/appearance$/); // not for a manager: sent to the one section they have
  }
});
