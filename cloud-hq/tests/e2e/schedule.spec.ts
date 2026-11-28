import { type Page } from '@playwright/test';
import { ADMIN, apiAs, expect, signIn, test } from './helpers';

// The schedule pages in a real browser (docs/18): shifts, a roster for a week, copying a week, leave, a holiday, and the plan set beside what happened.
// Self-contained: it makes its own shop and person through the API, so it does not depend on the other specs.
test.describe.configure({ mode: 'serial' });

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekStart = (day: string) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
const thisMonday = weekStart(new Date().toISOString().slice(0, 10));
const lastMonday = addDays(thisMonday, -7);
const lastWednesday = addDays(lastMonday, 2); // a day that is over, so a rostered day with no punches is an absence

const open = async (page: Page, tab?: string) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Schedule', level: 1 })).toBeVisible();
  if (tab) await page.getByRole('tab', { name: tab }).click();
};
const cell = (page: Page, day: string) => page.getByLabel(`Rami Saad, ${day}`);
const planOf = async (page: Page, day: string) => {
  await page.getByRole('tab', { name: 'Plan and what happened' }).click();
  await page.getByLabel('From').fill(day);
  await page.getByLabel('To').fill(day);
  await page.getByLabel('Branch').selectOption({ label: 'Schedule Shop' });
};

test('set-up: a shop and a person who works there', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  const api = await apiAs(page);
  const branch = await api.post('/branches', { code: 'SCH', name: 'Schedule Shop', kind: 'sale' });
  expect(branch.status()).toBe(201);
  const branchId = ((await branch.json()) as { branch: { id: number } }).branch.id;
  expect((await api.post('/employees', { code: 'S1', name: 'Rami Saad', branchIds: [branchId] })).status()).toBe(201);
});

test('shifts: a day shift and a night shift are added; a time that is not a time cannot be sent', async ({ page }) => {
  await open(page, 'Shifts and holidays');
  await page.getByLabel('Name', { exact: true }).first().fill('Morning');
  await page.getByRole('button', { name: 'Add the shift' }).click();
  await expect(page.getByText('The shift is added')).toBeVisible();
  await expect(page.getByTestId('shift-row').filter({ hasText: 'Morning' })).toContainText('08:00 to 16:00');

  await page.getByLabel('Name', { exact: true }).first().fill('Night');
  await page.getByLabel('Starts (hh:mm)').fill('22:00');
  await page.getByRole('button', { name: 'Add the shift' }).click();
  await expect(page.getByTestId('shift-row').filter({ hasText: 'Night' })).toContainText('22:00 to 06:00 (next day)');

  await page.getByLabel('Name', { exact: true }).first().fill('Broken');
  await page.getByLabel('Starts (hh:mm)').fill('25:00');
  await expect(page.getByRole('button', { name: 'Add the shift' })).toBeDisabled();
});

test('roster: shifts are set per day and kept; a week is copied to the next', async ({ page }) => {
  await open(page, 'Roster');
  await page.getByLabel('Branch').selectOption({ label: 'Schedule Shop' });
  await page.getByRole('button', { name: /Previous week/ }).click();
  for (const n of [0, 1, 2]) {
    await cell(page, addDays(lastMonday, n)).selectOption({ label: 'Morning' });
    await expect(cell(page, addDays(lastMonday, n))).toHaveValue(/\d+/);
  }
  // kept: leave the page and come back
  await page.getByRole('tab', { name: 'Leave' }).click();
  await page.getByRole('tab', { name: 'Roster' }).click();
  await page.getByLabel('Branch').selectOption({ label: 'Schedule Shop' });
  await page.getByRole('button', { name: /Previous week/ }).click();
  await expect(cell(page, lastWednesday)).not.toHaveValue('');

  // clearing a day is "off"
  await cell(page, addDays(lastMonday, 1)).selectOption({ label: 'off' });
  await expect(cell(page, addDays(lastMonday, 1))).toHaveValue('');
  await cell(page, addDays(lastMonday, 1)).selectOption({ label: 'Morning' });

  // copy last week into this one
  await page.getByRole('button', { name: /Next week/ }).click();
  await expect(cell(page, thisMonday)).toHaveValue('');
  await page.getByRole('button', { name: 'Copy last week' }).click();
  await expect(page.getByText('Copied 3 shifts from last week.')).toBeVisible();
  for (const n of [0, 1, 2]) await expect(cell(page, addDays(thisMonday, n))).not.toHaveValue('');
});

test('plan: a rostered day that is over with no punches is an absence; approved leave turns it into leave', async ({ page }) => {
  await open(page, 'Leave');
  // a kind of leave, then a request and its approval
  await page.getByLabel('Code', { exact: true }).fill('annual');
  await page.getByLabel('Name', { exact: true }).last().fill('Annual leave');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('The leave type is added')).toBeVisible();

  await planOf(page, lastWednesday);
  const row = page.getByTestId('plan-row').filter({ hasText: 'Rami Saad' });
  await expect(row).toContainText('Absent');

  await page.getByRole('tab', { name: 'Leave' }).click();
  await page.getByLabel('Person').selectOption({ label: 'Rami Saad' });
  await page.getByLabel('Kind').selectOption({ label: 'Annual leave (paid)' });
  await page.getByLabel('First day').fill(lastWednesday);
  await page.getByLabel('Last day').fill(lastWednesday);
  await page.getByLabel('Reason').fill('Family event');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('The request is recorded')).toBeVisible();
  const leave = page.getByTestId('leave-row').filter({ hasText: 'Rami Saad' });
  await expect(leave).toContainText('pending');
  await leave.getByRole('button', { name: 'Approve' }).click();
  await expect(leave).toContainText('approved');

  await planOf(page, lastWednesday);
  await expect(row).toContainText('On leave');
  await expect(row).toContainText('Annual leave, paid');

  // cancelled: the day is an absence again
  await page.getByRole('tab', { name: 'Leave' }).click();
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await expect(leave).toContainText('cancelled');
  await planOf(page, lastWednesday);
  await expect(row).toContainText('Absent');
});

test('holidays: a holiday on a rostered day is not an absence, and removing it brings the absence back', async ({ page }) => {
  await open(page, 'Shifts and holidays');
  await page.getByLabel('Day').fill(lastWednesday);
  await page.getByLabel('Name', { exact: true }).last().fill('Independence Day');
  await page.getByRole('button', { name: 'Add the holiday' }).click();
  await expect(page.getByTestId('holiday-row').filter({ hasText: 'Independence Day' })).toBeVisible();

  await planOf(page, lastWednesday);
  const row = page.getByTestId('plan-row').filter({ hasText: 'Rami Saad' });
  await expect(row).toContainText('Holiday');

  await page.getByRole('tab', { name: 'Shifts and holidays' }).click();
  await page.getByRole('button', { name: 'Remove Independence Day' }).click();
  await expect(page.getByTestId('holiday-row')).toHaveCount(0);
  await planOf(page, lastWednesday);
  await expect(row).toContainText('Absent');
});
