import { test, expect, type Page } from '@playwright/test';

// US-36: service income (IT support, a repair) from the manager's screen. Same throwaway stack as the other specs.
async function managerWithRegister(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const open = page.getByRole('button', { name: 'Open register' });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel('Cash LBP').fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}

test('US-36: a manager adds a service type, records a service paid at the till, and sees the profit and the totals', async ({ page }) => {
  await managerWithRegister(page);

  await page.goto('/products/lists');
  await page.getByRole('tab', { name: 'Service types' }).click();
  await page.getByLabel('New service type').fill('Repair');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('lookup-row').filter({ hasText: 'Repair' })).toBeVisible();

  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
  await page.getByRole('button', { name: 'New service' }).click();
  const dialog = page.getByRole('dialog', { name: 'New service' });
  await dialog.getByRole('button', { name: 'Save service' }).click();
  await expect(dialog.getByRole('alert')).toContainText('what the customer paid');

  await dialog.getByLabel('Type').selectOption({ label: 'Repair' });
  await dialog.getByLabel(/What the customer paid/).fill('25');
  await dialog.getByLabel(/What it cost you/).fill('10');
  await dialog.getByLabel('Note').fill('Replaced a power supply');
  await expect(dialog).toContainText('The USD balance of this drawer goes up');
  await dialog.getByRole('button', { name: 'Save service' }).click();
  await expect(page.getByText('Service recorded')).toBeVisible();

  const row = page.getByTestId('service-row').first();
  await expect(row).toContainText('Repair');
  await expect(row).toContainText('Replaced a power supply');
  await expect(row).toContainText('At the till');
  await expect(row).toContainText('$25.00');
  await expect(row).toContainText('$10.00');
  await expect(row).toContainText('$15.00'); // the profit
  await expect(page.getByTestId('service-total')).toContainText('$25.00');
});

test('US-36: a cashier has no Services page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByLabel('Password').fill('test-cashier-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Menu/ })).toBeVisible();
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Services' })).toHaveCount(0);
});
