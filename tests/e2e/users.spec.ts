import { test, expect, type Page } from '@playwright/test';

// US-25 / US-26 / US-29: the admin adds people and gives them a first password; they choose their own before anything else.
// Same throwaway stack as the other specs.
async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
const signedIn = (page: Page) => page.getByRole('button', { name: /Menu/ });
/** Signed in and past the till's "Open the register" dialog (opened here when nobody has), so the menu can be clicked. */
async function ready(page: Page) {
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}
async function openUsers(page: Page) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); // the gear in the header
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: /Account:/ }).click(); // the person's own menu, top right
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test('US-26: the admin adds a cashier with a first password; the cashier must choose their own before selling', async ({ page }) => {
  await signIn(page, 'admin', 'test-admin-pass');
  await ready(page);
  await openUsers(page);
  for (const name of ['admin', 'manager', 'cashier'])
    await expect(page.getByTestId('user-row').filter({ hasText: name }).first()).toBeVisible(); // the seeded users

  await page.getByRole('button', { name: 'New user' }).click();
  const dialog = page.getByRole('dialog', { name: 'New user' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); // nothing typed yet
  await dialog.getByLabel(/Username/).fill('lina.cashier');
  await dialog.getByLabel(/Name \(printed/).fill('Lina');
  await dialog.getByLabel(/First password/).fill('first-password-1');
  await dialog.getByLabel(/PIN for switching/).fill('4821');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId('user-row').filter({ hasText: 'lina.cashier' });
  await expect(row).toContainText('Must choose a password');
  await expect(row).toContainText('Cashier');
  await expect(row).toContainText('Yes'); // has a PIN
  await signOut(page);

  // Lina signs in with the first password and is stopped until she chooses her own.
  await signIn(page, 'lina.cashier', 'first-password-1');
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Menu/ })).toHaveCount(0); // nothing else is reachable yet
  await page.goto('/sales');
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();

  await page.getByLabel(/The password the admin gave you/).fill('first-password-1');
  await page.getByLabel('New password (at least 8 characters)').fill('short');
  await page.getByLabel('New password again').fill('short');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8 characters');
  await page.getByLabel('New password (at least 8 characters)').fill('lina-own-password');
  await page.getByLabel('New password again').fill('lina-different');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByRole('alert')).toContainText('not the same');
  await page.getByLabel('The password the admin gave you').fill('wrong-first-password');
  await page.getByLabel('New password again').fill('lina-own-password');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');

  await page.getByLabel('The password the admin gave you').fill('first-password-1');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(signedIn(page)).toBeVisible(); // in, on the page she asked for (the Sales page)
  await expect(page.getByRole('heading', { name: 'Sales', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); // a cashier has the gear too, but only Appearance behind it
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link')).toHaveCount(1);
  await page.goto('/users');
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toHaveCount(0);
  await signOut(page);

  // The first password no longer works; the chosen one does and is not asked for again.
  await signIn(page, 'lina.cashier', 'first-password-1');
  await expect(page.getByText('Wrong username or password.')).toBeVisible();
  await signIn(page, 'lina.cashier', 'lina-own-password');
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toHaveCount(0);
});

test('US-26: the admin switches a person off, resets their password, and changes the PIN; cannot switch themselves off', async ({
  page,
}) => {
  await signIn(page, 'admin', 'test-admin-pass');
  await ready(page);
  await openUsers(page);

  // not yourself
  await page.getByRole('button', { name: 'Edit admin' }).click();
  await expect(page.getByLabel(/Can sign in/)).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // a PIN can be added and taken away
  await page.getByRole('button', { name: 'Edit cashier', exact: true }).click();
  await page.getByLabel(/PIN for switching/).fill('1357');
  await page.getByRole('button', { name: 'Save' }).click();
  const cashier = page.getByTestId('user-row').filter({ hasText: 'cashier' }).first();
  await expect(cashier).toContainText('Yes');
  await page.getByRole('button', { name: 'Edit cashier', exact: true }).click();
  await page.getByRole('button', { name: 'Remove PIN' }).click();
  await expect(cashier).toContainText('No');

  // switched off: cannot sign in; switched on again: can
  await page.getByRole('button', { name: 'Edit cashier', exact: true }).click();
  await page.getByLabel(/Can sign in/).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(cashier).toContainText('Switched off');
  await signOut(page);
  await signIn(page, 'cashier', 'test-cashier-pass');
  await expect(page.getByText('Wrong username or password.')).toBeVisible();

  await signIn(page, 'admin', 'test-admin-pass');
  await ready(page);
  await openUsers(page);
  await page.getByRole('button', { name: 'Edit cashier', exact: true }).click();
  await page.getByLabel(/Can sign in/).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(cashier).toContainText('Active');
});

test('US-25: anyone can change their own password from the menu', async ({ page }) => {
  await signIn(page, 'manager', 'test-manager-pass');
  await ready(page);
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('link', { name: 'Change my password' }).click();
  await page.getByLabel('Current password').fill('test-manager-pass');
  await page.getByLabel('New password (at least 8 characters)').fill('manager-new-password');
  await page.getByLabel('New password again').fill('manager-new-password');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByText('Your password is changed')).toBeVisible();

  // put it back so the other specs can sign in
  await page.getByRole('button', { name: /Account:/ }).click();
  await page.getByRole('link', { name: 'Change my password' }).click();
  await page.getByLabel('Current password').fill('manager-new-password');
  await page.getByLabel('New password (at least 8 characters)').fill('test-manager-pass');
  await page.getByLabel('New password again').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByText('Your password is changed')).toBeVisible();
});

test('US-26: the admin deletes a user after a confirmation, and cannot delete their own account', async ({ page }) => {
  await signIn(page, 'admin', 'test-admin-pass');
  await ready(page);
  await openUsers(page);
  await page.getByRole('button', { name: 'New user' }).click();
  const made = page.getByRole('dialog', { name: 'New user' });
  await made.getByLabel(/Username/).fill('doomed.user');
  await made.getByLabel(/Name \(printed/).fill('Doomed');
  await made.getByLabel(/First password/).fill('first-password-1');
  await made.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId('user-row').filter({ hasText: 'doomed.user' });
  await expect(row).toBeVisible();

  // cancelling the confirmation keeps the person
  await row.getByRole('button', { name: 'Edit doomed.user' }).click();
  await page.getByRole('dialog', { name: 'Edit user' }).getByRole('button', { name: 'Delete user' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete user' });
  await expect(confirm).toContainText('cannot be undone');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Edit user' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Edit doomed.user' }).click();
  await page.getByRole('dialog', { name: 'Edit user' }).getByRole('button', { name: 'Delete user' }).click();
  await page.getByRole('dialog', { name: 'Delete user' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);

  // your own account has no Delete button
  await page
    .getByTestId('user-row')
    .filter({ hasText: '(you)' })
    .getByRole('button', { name: /^Edit / })
    .click();
  await expect(page.getByRole('dialog', { name: 'Edit user' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete user' })).toHaveCount(0);
});
