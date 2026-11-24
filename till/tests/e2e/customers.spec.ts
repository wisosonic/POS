import { test, expect, type Page } from '@playwright/test';

// US-24: the Customer accounts page lists every customer, whether or not they owe, with add / edit / delete. Debts (a separate page)
// lists only those who owe. Same throwaway stack as checkout.spec.ts.
const PASSWORDS: Record<string, string> = { cashier: 'test-cashier-pass', manager: 'test-manager-pass' };

async function signedInAt(page: Page, user: 'cashier' | 'manager', path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(PASSWORDS[user]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}
const row = (page: Page, name: string) => page.getByTestId('customer-row').filter({ hasText: name });

test('US-24: a manager adds, edits and deletes a customer; the list shows everyone, owing or not', async ({ page }) => {
  await signedInAt(page, 'manager', '/customers');
  await expect(page.getByRole('heading', { name: 'Customer accounts' })).toBeVisible();
  await expect(row(page, 'Test Customer')).toBeVisible(); // the seeded customer owes nothing and is listed all the same

  // add
  await page.getByRole('button', { name: 'New customer' }).click();
  const made = page.getByRole('dialog', { name: 'New customer' });
  await made.getByRole('button', { name: 'Save' }).click();
  await expect(made.getByRole('alert')).toContainText('Type the name'); // nothing typed yet
  await made.getByLabel('Name').fill('Layla Crud');
  await made.getByLabel('Phone').fill('03123456');
  await made.getByLabel('Address').fill('Hamra, Beirut');
  await made.getByLabel('Email').fill('layla@example.com');
  await made.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'Layla Crud')).toContainText('03123456');
  await expect(row(page, 'Layla Crud')).toContainText('Hamra, Beirut');
  await expect(row(page, 'Layla Crud')).toContainText('layla@example.com');

  // edit
  await row(page, 'Layla Crud').getByRole('button', { name: 'Edit Layla Crud' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit customer' });
  await expect(edit.getByLabel('Phone')).toHaveValue('03123456');
  await edit.getByLabel('Name').fill('Layla Renamed');
  await edit.getByLabel('Phone').fill('');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'Layla Renamed')).toBeVisible();
  await expect(row(page, 'Layla Renamed')).not.toContainText('03123456'); // a cleared phone is cleared

  // search
  await page.getByRole('searchbox').fill('renamed');
  await expect(page.getByTestId('customer-row')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');

  // delete: Cancel keeps them, Delete removes them
  await row(page, 'Layla Renamed').getByRole('button', { name: 'Delete Layla Renamed' }).click();
  const gone = page.getByRole('dialog', { name: 'Delete customer' });
  await expect(gone).toContainText('cannot be undone');
  await gone.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'Layla Renamed')).toBeVisible();
  await row(page, 'Layla Renamed').getByRole('button', { name: 'Delete Layla Renamed' }).click();
  await page.getByRole('dialog', { name: 'Delete customer' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Layla Renamed')).toHaveCount(0);
});

test('US-24: someone who owes money cannot be deleted; Debts lists only the people who owe', async ({ page }) => {
  await signedInAt(page, 'manager', '/customers');
  // Ahmad Darwish owes money (see checkout.spec): the list shows what, and delete is refused with the reason
  const ahmad = row(page, 'Ahmad Darwish');
  await expect(ahmad).toBeVisible();
  await expect(ahmad.locator('td.num').first()).toContainText('LL');
  await ahmad.getByRole('button', { name: 'Delete Ahmad Darwish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete customer' });
  await expect(dialog).toContainText('still owes');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('still owes money');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(ahmad).toBeVisible();

  // Debts: only those who owe, with Receive payment
  await page.goto('/debts');
  await expect(page.getByRole('heading', { name: 'Debts' })).toBeVisible();
  await expect(page.getByRole('row', { name: /ahmad darwish/i })).toBeVisible();
  await expect(page.getByRole('row', { name: /test customer/i })).toHaveCount(0); // owes nothing: not a debt
  await expect(page.getByRole('row', { name: /ahmad darwish/i }).getByRole('button', { name: 'Receive payment' })).toBeVisible();
});

test('US-24: a cashier can add a customer and browse their sales, but not edit or delete', async ({ page }) => {
  await signedInAt(page, 'cashier', '/customers');
  await expect(row(page, 'Test Customer')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  await expect(row(page, 'Test Customer').getByRole('button', { name: /Browse sales of/ })).toBeVisible();

  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByRole('dialog', { name: 'New customer' }).getByLabel('Name').fill('Added by a cashier');
  await page.getByRole('dialog', { name: 'New customer' }).getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'Added by a cashier')).toBeVisible();
});

test('US-24: the buttons at the end of a Debts row line up on one line, at the same height', async ({ page }) => {
  await signedInAt(page, 'manager', '/debts');
  const actions = page.getByRole('row', { name: /ahmad darwish/i }).locator('.row-actions');
  const sales = await actions.getByRole('button', { name: /Browse sales of/ }).boundingBox();
  const pay = await actions.getByRole('button', { name: 'Receive payment' }).boundingBox();
  expect(Math.abs(sales!.y - pay!.y)).toBeLessThan(1);
  expect(Math.abs(sales!.height - pay!.height)).toBeLessThan(1);
  expect(pay!.x).toBeGreaterThan(sales!.x + sales!.width); // side by side, not stacked
});
