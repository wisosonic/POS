import { test, expect, type Page } from '@playwright/test';

// US-15: a manager brings products in from a spreadsheet saved as CSV. Same throwaway stack as the other specs.
const csvFile = (text: string) => ({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

async function managerAt(page: Page, path: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto(path);
}

async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Import CSV…' }).click();
  await expect(page.getByRole('dialog', { name: 'Import products' })).toBeVisible();
}

test('US-15: a file with a problem shows the row and the reason and cannot be imported', async ({ page }) => {
  await managerAt(page, '/products');
  await openImport(page);
  const dialog = page.getByRole('dialog', { name: 'Import products' });
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled(); // nothing chosen yet

  await dialog
    .getByLabel('CSV file')
    .setInputFiles(csvFile('name,barcode,price\nFine item,7810000000011,1000\nBroken item,7810000000028,"75,000"\n'));
  await expect(dialog.getByTestId('import-summary')).toContainText('1 new');
  await expect(dialog.getByTestId('import-summary')).toContainText('1 with a problem');
  await expect(dialog.getByTestId('import-summary')).toContainText('Nothing is imported until every problem is fixed');
  const bad = dialog.locator('[data-testid="import-row"][data-action="error"]');
  await expect(bad).toHaveCount(1);
  await expect(bad).toContainText('3'); // the row, as the spreadsheet numbers it
  await expect(bad).toContainText('Broken item');
  await expect(bad).toContainText('not a whole number of lira');
  await expect(dialog.getByRole('button', { name: /^Import/ }).last()).toBeDisabled();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('searchbox').fill('Fine item');
  await expect(page.getByText('Fine item')).toHaveCount(0); // not even the good row was written
});

test('US-15: a good file is checked, then imported; a missing category is created only when the box is ticked', async ({ page }) => {
  await managerAt(page, '/products');
  await openImport(page);
  const dialog = page.getByRole('dialog', { name: 'Import products' });
  const file =
    'name,barcode,price,currency,category\nImported tea,7820000000011,3.50,USD,Teas\nImported coffee,7820000000028,45000,LBP,Teas\n';

  await dialog.getByLabel('CSV file').setInputFiles(csvFile(file));
  await expect(dialog.getByTestId('import-summary')).toContainText('2 with a problem'); // no category called Teas yet
  await expect(dialog.getByTestId('import-row').first()).toContainText('no category called "Teas"');

  await dialog.getByLabel('Create categories, brands and suppliers that are not there yet').check();
  await expect(dialog.getByTestId('import-summary')).toContainText('2 new');
  await expect(dialog.getByTestId('import-summary')).toContainText('New in Lists: Teas (category)');
  await dialog.getByRole('button', { name: 'Import 2 products' }).click();
  await expect(page.getByText('Imported: 2 new, 0 changed')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Import products' })).toHaveCount(0);

  await page.getByRole('searchbox').fill('Imported tea');
  await expect(page.getByTestId('product-row')).toHaveCount(1);
  await expect(page.getByTestId('product-row')).toContainText('Imported tea');

  // the same file again: nothing left to do
  await openImport(page);
  await page.getByRole('dialog', { name: 'Import products' }).getByLabel('CSV file').setInputFiles(csvFile(file));
  await expect(page.getByTestId('import-summary')).toContainText('0 new · 0 changed · 2 already as in the file');
  await expect(page.getByRole('dialog', { name: 'Import products' }).getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
});

test('US-15: a cashier has no Products page to import from', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Menu/ }).or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/products');
  await expect(page.getByRole('button', { name: 'Import CSV…' })).toHaveCount(0);
});
