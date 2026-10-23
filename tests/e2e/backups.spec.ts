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
  await expect(page).toHaveURL(/\/settings\/appearance$/); // a manager's Settings has only Appearance: sent there, not to Backups

  const other = await (await browser.newContext({ baseURL })).newPage();
  await login(other, 'cashier');
  await expect(other.getByTestId('backup-overdue')).toHaveCount(0);
});

test('US-30: the admin sees the warning, makes a backup, and the warning goes away', async ({ page }) => {
  await login(page, 'admin');
  // For the admin the warning is a link to the Backups page. (The register-opening dialog covers the page on a fresh server, so go there directly.)
  await expect(page.getByTestId('backup-overdue')).toHaveAttribute('href', '/settings/backups');
  await page.goto('/settings/backups');
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

test('US-30: the admin sees when and how big the last backup is, and a restore needs an explicit confirmation', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/settings/backups');
  // the spec above made two backups; this one only looks, so it leaves the server as it found it
  await expect(page.getByTestId('backup-latest')).toContainText(/Latest: \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}.* · \d+(\.\d)? (KB|MB)/);

  await page
    .getByRole('button', { name: /^Restore pos-/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Restore a backup' });
  await expect(dialog).toContainText('Everything done after this backup will be gone');
  const go = dialog.getByRole('button', { name: 'Restore', exact: true });
  await expect(go).toBeDisabled(); // not until the box is ticked
  await dialog.getByLabel(/I understand/).check();
  await expect(go).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('backup-file')).toHaveCount(2); // cancelling changed nothing: no safety backup was made
});
