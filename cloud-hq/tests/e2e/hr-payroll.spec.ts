import { ADMIN, apiAs, daysAgo, expect, lastMonth, signIn, test } from './helpers';

// The HR and payroll pages in a real browser (docs/18): one person from "added" to "paid and reading their own payslip".
test.describe.configure({ mode: 'serial' });
const period = lastMonth();
const row = (page: import('@playwright/test').Page) => page.getByTestId('employee-row').filter({ hasText: 'Lina Khoury' });

test('set-up: a shop, an exchange rate (payroll records the rate it used) and a person who works there', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  const api = await apiAs(page);
  expect((await api.post('/branches', { code: 'HAM', name: 'Hamra', kind: 'sale' })).status()).toBe(201);
  expect((await api.post('/exchange-rates', { rateLbpPerUsd: 90000 })).status()).toBe(201);

  await page.getByRole('link', { name: 'People' }).click();
  await page.getByLabel('Code (on their badge)').fill('E7');
  await page.getByLabel('Full name').fill('Lina Khoury');
  await page.locator('fieldset').getByLabel('Hamra').check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row(page)).toBeVisible();
  await expect(row(page).getByLabel('Hamra')).toBeChecked();
});

test('the attendance PIN is typed once and never shown, and a sign-in can be given', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'People' }).click();
  // one handler, answering each question by what it asks
  page.on('dialog', (d) => {
    const ask = d.message();
    if (ask.includes('attendance PIN')) void d.accept('4321');
    else if (ask.includes('to sign in with')) void d.accept('lina.k');
    else if (ask.includes('temporary password')) void d.accept('Another-Long-Pass-77');
    else void d.dismiss();
  });
  await row(page).getByRole('button', { name: 'Set PIN' }).click();
  await expect(page.getByText('A new attendance PIN is set for Lina Khoury')).toBeVisible();
  expect(await page.content()).not.toContain('4321');
  await expect(row(page).getByText('set', { exact: true })).toBeVisible();

  await row(page).getByRole('button', { name: 'Give a sign-in' }).click();
  await expect(page.getByText('A sign-in is made for Lina Khoury')).toBeVisible();
});

test('pay setup: a rule and a pay from a day on; a fraction of a lira cannot even be sent', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Pay setup' }).click();
  await page.getByLabel('Code', { exact: true }).fill('nssf');
  await page.getByLabel('Name', { exact: true }).fill('NSSF employee');
  await page.getByLabel('Rate (%)').fill('2');
  await page.getByLabel('From').fill(period.longAgo);
  await page.getByRole('button', { name: 'Save from this day' }).last().click();
  await expect(page.getByText('The rule is saved')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'NSSF employee' })).toBeVisible();

  await page.getByLabel('Person').first().selectOption({ label: 'Lina Khoury' });
  await page.getByLabel('From').first().fill(period.longAgo);
  await page.getByLabel(/^Amount \(per month\)/).fill('900000');
  await page.getByLabel('NSSF').check();
  await page.getByRole('button', { name: 'Save from this day' }).first().click();
  await expect(page.getByText('The new pay is saved')).toBeVisible();
  await expect(page.getByText(/900,000 L\.L\./).first()).toBeVisible();

  await page.getByLabel(/^Amount \(per month\)/).fill('90000.5');
  await expect(page.getByRole('button', { name: 'Save from this day' }).first()).toBeDisabled();
});

test('attendance: a lone clock-in is flagged, the missing clock-out is added with a reason, and 8 h 00 is worked', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Attendance' }).click();
  await expect(page.getByRole('heading', { name: 'Add a missed punch' })).toBeVisible();
  await page.getByLabel('From').first().fill(period.first);
  await expect(page.getByLabel('Person').last().locator('option', { hasText: 'Lina Khoury' })).toHaveCount(1);

  const add = async (day: string, kind: 'in' | 'out', time: string, reason: string) => {
    await page.getByLabel('Person').last().selectOption({ label: 'Lina Khoury' });
    await page.getByLabel('Branch').last().selectOption({ label: 'Hamra' });
    await page.getByLabel('Clock').selectOption(kind);
    await page.getByLabel('When').fill(`${day}T${time}`);
    await page.getByLabel(/Reason/).fill(reason);
    await page.getByRole('button', { name: 'Add the punch' }).click();
    await expect(page.getByText('The punch is added')).toBeVisible();
  };
  await add(period.mid, 'in', '08:00', 'Forgot to clock in');
  await expect(page.getByText('Still clocked in').first()).toBeVisible();
  await add(period.mid, 'out', '16:00', 'Forgot to clock out');
  await expect(page.getByText('8 h 00').first()).toBeVisible();
  // a recent day too, so the employee's own two-week view has something to show
  const yesterday = daysAgo(1);
  await add(yesterday, 'in', '09:00', 'Phone was dead');
  await add(yesterday, 'out', '17:00', 'Phone was dead');
  await expect(page.getByTestId('attendance-row')).toHaveCount(2);
});

test('payroll: calculate, see the NSSF line, add and remove an extra line, approve, pay, lock; a locked run offers nothing more', async ({
  page,
}) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Payroll' }).click();
  await page.getByRole('heading', { name: 'Start a payroll run' }).waitFor();
  await page.getByLabel('From').fill(period.first);
  await page.getByLabel('To').fill(period.last);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Payroll ${period.first} to ${period.last}` })).toBeVisible();

  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByText('Worked out 1 payslip.')).toBeVisible();
  const slip = page.getByTestId('slip-row').filter({ hasText: 'Lina Khoury' });
  await expect(slip).toBeVisible();
  await slip.getByRole('button', { name: 'Lines' }).click();
  await expect(page.getByText('NSSF employee').first()).toBeVisible();

  await page.getByLabel('Person').selectOption({ label: 'Lina Khoury' });
  await page.getByLabel('What for').fill('Eid bonus');
  await page.getByLabel(/^Amount \(LBP\)/).fill('100000');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Eid bonus' })).toBeVisible();
  await page.getByRole('button', { name: 'Calculate again' }).click();
  await expect(page.getByText('Worked out 1 payslip.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Eid bonus' }).click();
  await expect(page.getByRole('button', { name: 'Remove Eid bonus' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Calculate again' }).click();

  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.steps li.now')).toHaveText('approved');
  await page.getByRole('button', { name: 'Mark as paid' }).click();
  await expect(page.locator('.steps li.now')).toHaveText('paid');
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.locator('.steps li.now')).toHaveText('locked');
  await expect(page.getByRole('button', { name: /Calculate|Approve|Mark as paid|Lock/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);

  const [popup] = await Promise.all([page.waitForEvent('popup'), slip.getByRole('button', { name: 'Print' }).click()]);
  await popup.waitForLoadState();
  await expect(popup.locator('body')).toContainText('Lina Khoury');
  await popup.close();
});

test('the employee chooses a password and sees only their own payslip and attendance, with no menu', async ({ page }) => {
  await signIn(page, 'lina.k', 'Another-Long-Pass-77');
  await page.getByLabel('The password you were given').fill('Another-Long-Pass-77');
  await page.getByLabel(/^New password \(at least/).fill('Lina-Own-Pass-2026-x');
  await page.getByLabel('New password again').fill('Lina-Own-Pass-2026-x');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Lina Khoury' })).toBeVisible();
  await expect(page.getByTestId('my-slip')).toHaveCount(1);
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '8 h 00' }).first()).toBeVisible(); // yesterday, within the two weeks
  // the payroll page is not reachable by address either
  await page.goto('/payroll');
  await expect(page.getByRole('heading', { name: 'Hello, Lina Khoury' })).toBeVisible();
});
