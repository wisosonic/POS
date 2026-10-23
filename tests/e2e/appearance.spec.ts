import { test, expect, type Page } from '@playwright/test';

// Settings > Appearance: light or dark, and the size of the letters, for anyone (a cashier too), kept in the browser.
async function signIn(page: Page, user: 'cashier' | 'admin') {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(`test-${user}-pass`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click(); // the till's dialog covers the header until the register is open
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const rootSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
const openAppearance = async (page: Page) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
};

test.use({ colorScheme: 'light' });

test('a cashier chooses dark colours and larger letters; both apply at once and are still there after a reload', async ({ page }) => {
  await signIn(page, 'cashier');
  await openAppearance(page);
  await expect(page.getByRole('radio', { name: /^Like this computer/ })).toBeChecked(); // the starting point
  await expect(page.getByRole('radio', { name: 'Normal' })).toBeChecked();
  const light = await background(page);
  expect(await rootSize(page)).toBe('16px');

  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Dark', { exact: true }) })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).not.toBe(light);

  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Large', { exact: true }) })
    .click();
  expect(await rootSize(page)).toBe('18px'); // 112.5% of 16
  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Extra large', { exact: true }) })
    .click();
  expect(await rootSize(page)).toBe('20px');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // kept, and applied before the screen is drawn
  expect(await rootSize(page)).toBe('20px');
  await expect(page.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Extra large' })).toBeChecked();

  // the till itself follows
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  expect(await rootSize(page)).toBe('20px');

  await openAppearance(page);
  await page.getByRole('button', { name: 'Back to the usual look' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await rootSize(page)).toBe('16px');
  await expect(page.getByRole('button', { name: 'Back to the usual look' })).toBeDisabled();
});

test('"light" wins over a dark computer, and "like this computer" follows it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, 'admin');
  const dark = await background(page); // like the computer: dark
  await openAppearance(page);
  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Light', { exact: true }) })
    .click();
  const light = await background(page);
  expect(light).not.toBe(dark);
  expect(light).toBe('rgb(245, 243, 238)'); // the paper colour
  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Like this computer', { exact: true }) })
    .click();
  expect(await background(page)).toBe(dark);
  await expect(page.getByRole('button', { name: 'Back to the usual look' })).toBeDisabled();
});

test('the choice is for this browser: a fresh browser starts with the usual look', async ({ page, browser, baseURL }) => {
  await signIn(page, 'cashier');
  await openAppearance(page);
  await page
    .locator('label.choice')
    .filter({ has: page.getByText('Dark', { exact: true }) })
    .click();
  const fresh = await (await browser.newContext({ baseURL, colorScheme: 'light' })).newPage();
  await signIn(fresh, 'cashier');
  await expect(fresh.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  await openAppearance(fresh);
  await expect(fresh.getByRole('radio', { name: /^Like this computer/ })).toBeChecked();
});
