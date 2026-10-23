import { test, expect } from '@playwright/test';

// US-21/22/23: ordering from a supplier, receiving in parts, paying. Same throwaway stack as the other specs.
// Stock only drives alerts (R2), so nothing here depends on how much of a product is on hand.

test('US-21/22/23: order, receive in two deliveries, pay in part, and the stock follows', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/purchases');

  await page.getByRole('button', { name: 'New purchase' }).click();
  await page.getByLabel('Supplier').selectOption({ label: 'Test Supplier' });
  await page.getByLabel('Add a product').fill('rare');
  await page.getByRole('option', { name: /Rare item/ }).click();
  await page.getByLabel('Quantity of Rare item').fill('10');
  await page.getByLabel('Cost of Rare item').fill('6000');
  await expect(page.getByTestId('purchase-total')).toHaveText(/60,000/);
  await page.getByRole('button', { name: 'Place order' }).click();

  // First delivery: 4 of the 10 arrive. The order stays open for the rest.
  await page.getByLabel('Arrived now: Rare item').fill('4');
  await page.getByRole('button', { name: 'Receive the quantities above' }).click();
  await expect(page.getByLabel('Arrived now: Rare item')).toHaveValue('');
  await expect(page.getByRole('cell', { name: '6', exact: true })).toBeVisible(); // 6 still to come

  // Pay 20,000 of the 60,000 while the rest is still on its way.
  await page.getByLabel('Amount paid (LBP)').fill('20000');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByTestId('purchase-owed')).toHaveText(/40,000/);

  // An overpayment is refused before it reaches the server.
  await page.getByLabel('Amount paid (LBP)').fill('50000');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('alert')).toContainText('Only 40,000 LL is owed');

  // Second delivery: the rest.
  await page.getByRole('button', { name: 'Receive everything' }).click();
  await expect(page.getByRole('button', { name: 'Receive everything' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const row = page.getByTestId('purchase-row').first();
  await expect(row).toContainText('Received');
  await expect(row).toContainText('40,000 LL'); // still owed

  // The stock went from 1 to 11 through the two deliveries.
  await page.goto('/products');
  await page.getByRole('searchbox').fill('rare');
  await expect(page.getByTestId('product-row').first()).toContainText('11');
});

test('US-21: a draft can be saved, reopened, and deleted; any product can be ordered whatever its stock', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('checkout').or(page.getByRole('button', { name: 'Open register' }))).toBeVisible();
  await page.goto('/purchases');

  await expect(page.getByText('Loading…')).toHaveCount(0); // count the rows only once the list has arrived
  const before = await page.getByTestId('purchase-row').count();
  await page.getByRole('button', { name: 'New purchase' }).click();
  await page.getByLabel('Add a product').fill('chocolate');
  await page.getByRole('option', { name: /Crispy chocolate/ }).click();
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByTestId('purchase-row')).toHaveCount(before + 1);

  await page
    .getByTestId('purchase-row')
    .first()
    .getByRole('button', { name: /Open purchase/ })
    .click();
  await expect(page.getByTestId('purchase-line')).toHaveCount(1);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await expect(page.getByTestId('purchase-row')).toHaveCount(before);
});
