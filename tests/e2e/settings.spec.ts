import { test, expect, type Page } from '@playwright/test';

// The admin sets the exchange rate and the shop details, and checks the printer. Other specs rely on 90,000 and the shop
// name, so each test puts back what it changed.
async function adminAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('test-admin-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

test('the admin changes the exchange rate; a likely typo has to be confirmed; the rate can be put back', async ({ page }) => {
  await adminAt(page, '/rate');
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
  await adminAt(page, '/settings');
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

test('only the admin has these screens; the header does not show the rate, and the rate screen is behind the gear', async ({
  page,
  browser,
  baseURL,
}) => {
  await adminAt(page, '/');
  await expect(page.getByText(/1\$ = /)).toHaveCount(0); // not in the header any more
  await page.getByRole('button', { name: 'Settings and administration' }).click();
  await expect(page.getByRole('link', { name: 'Exchange rate' })).toHaveAttribute('href', '/rate');
  await page.keyboard.press('Escape');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const other = await (await browser.newContext({ baseURL })).newPage();
  await other.goto('/login');
  await other.getByLabel('Username').fill('manager');
  await other.getByLabel('Password').fill('test-manager-pass');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByTestId('checkout').or(other.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await expect(other.getByText(/1\$ = /)).toHaveCount(0);
  await expect(other.getByRole('button', { name: 'Settings and administration' })).toHaveCount(0); // no gear for a manager
  for (const path of ['/settings', '/rate']) {
    await other.goto(path);
    await expect(other).toHaveURL(/\/$/);
  }
});
