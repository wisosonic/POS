import { test, expect, type Page } from '@playwright/test';

// US-30: the owner hears about a missing backup, and the admin can make one. The e2e server has backups switched on with
// no schedule, so "no backup yet" is true until this test makes one.
const PASSWORDS = { cashier: 'test-cashier-pass', manager: 'test-manager-pass', admin: 'test-admin-pass' };

async function login(page: Page, user: keyof typeof PASSWORDS) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(PASSWORDS[user]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
}

test('US-30: a manager sees the warning but has no Backups page; the cashier sees nothing', async ({ page, browser, baseURL }) => {
  await login(page, 'manager');
  await expect(page.getByTestId('backup-overdue')).toBeVisible();
  await expect(page.getByTestId('backup-overdue')).not.toHaveAttribute('href', /.*/); // not a link: only the admin can act on it
  await page.goto('/backups');
  await expect(page).toHaveURL(/\/$/); // sent back to the till

  const other = await (await browser.newContext({ baseURL })).newPage();
  await login(other, 'cashier');
  await expect(other.getByTestId('backup-overdue')).toHaveCount(0);
});

test('US-30: the admin sees the warning, makes a backup, and the warning goes away', async ({ page }) => {
  await login(page, 'admin');
  // For the admin the warning is a link to the Backups page. (The register-opening dialog covers the page on a fresh server, so go there directly.)
  await expect(page.getByTestId('backup-overdue')).toHaveAttribute('href', '/backups');
  await page.goto('/backups');
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await expect(page.getByTestId('backup-banner')).toContainText('No backup has been made yet');
  await expect(page.getByTestId('backup-banner')).toContainText('NOT encrypted'); // the test server has no passphrase
  await expect(page.getByTestId('backup-file')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByTestId('backup-file')).toHaveCount(1);
  await expect(page.getByTestId('backup-file').first()).toContainText(/pos-\d{8}-\d{6}\.db/);
  await expect(page.getByTestId('backup-banner')).toContainText('Backups are working');
  await expect(page.getByTestId('backup-overdue')).toHaveCount(0);

  // a second one is a second file
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByTestId('backup-file')).toHaveCount(2);
});
