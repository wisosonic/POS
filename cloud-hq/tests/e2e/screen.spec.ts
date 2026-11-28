import { ADMIN, expect, signIn, test } from './helpers';

// The HQ screen in a real browser (docs/18): sign-in, who sees what, the one-time branch code, the strict page headers.
test.describe.configure({ mode: 'serial' });

test('a wrong password is refused in plain words, the right one signs in, and a reload stays signed in (US-HQ-screen)', async ({
  page,
}) => {
  await signIn(page, ADMIN.name, 'not-the-password-at-all');
  await expect(page.getByRole('alert')).toContainText('wrong');
  await expect(page.getByRole('heading', { name: 'HQ sign in' })).toBeVisible();

  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  await expect(page.getByTestId('health')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
});

test('the page comes with a policy that allows only its own scripts, and the token is kept for the tab only', async ({ page }) => {
  const res = await page.goto('/');
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('hq-session'))).not.toBeNull();
});

test('adding a branch shows its one-time code once, and the code is gone when the page is left', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Branches' }).click();
  await page.getByLabel('Short code (1 to 8 letters or digits)').fill('SPR');
  await page.getByLabel('Name').fill('Sprouts Verdun');
  await page.getByRole('button', { name: 'Add and make its code' }).click();
  const box = page.getByTestId('enrol-code');
  await expect(box).toContainText('Sprouts Verdun');
  await expect(box.locator('.code')).toHaveText(/\S{8,}/);
  const code = (await box.locator('.code').innerText()).trim();
  await expect(page.getByRole('row').filter({ hasText: 'Sprouts Verdun' }).getByText('waiting for its code')).toBeVisible();

  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('link', { name: 'Branches' }).click();
  await expect(page.getByRole('heading', { name: 'Branches', level: 1 })).toBeVisible(); // not the Overview's own Branches section
  await expect(page.getByRole('row').filter({ hasText: 'Sprouts Verdun' })).toBeVisible();
  await expect(page.getByTestId('enrol-code')).toHaveCount(0);
  expect(await page.content()).not.toContain(code);
});

test('the backups page tells an admin plainly that HQ is not making backups here', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Backups' }).click();
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await expect(page.getByText('HQ is not making backups')).toBeVisible();
});

test('a viewer sees the chain but none of the admin or pay pages, and is stopped at "choose your password" first', async ({
  page,
  browser,
}) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByLabel('Name to sign in with').fill('viewer.one');
  await page.getByLabel('Full name').fill('Vera Viewer');
  await page.getByLabel(/Temporary password/).fill('Temporary-Pass-123');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('staff-row').filter({ hasText: 'Vera Viewer' })).toBeVisible();

  const other = await browser.newContext();
  const vp = await other.newPage();
  const problems: string[] = [];
  vp.on('pageerror', (e) => problems.push(e.message));
  await signIn(vp, 'viewer.one', 'Temporary-Pass-123');
  await expect(vp.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await vp.getByLabel('The password you were given').fill('Temporary-Pass-123');
  await vp.getByLabel(/^New password \(at least/).fill('Vera-Own-Password-2026');
  await vp.getByLabel('New password again').fill('Vera-Own-Password-2026');
  await vp.getByRole('button', { name: 'Save password' }).click();
  await expect(vp.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  for (const hidden of ['Staff', 'Backups', 'Payroll', 'Pay setup'])
    await expect(vp.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
  for (const shown of ['Branches', 'People', 'Attendance']) await expect(vp.getByRole('link', { name: shown, exact: true })).toBeVisible();
  await vp.goto('/payroll');
  await expect(vp.getByRole('heading', { name: 'The chain today' })).toBeVisible(); // sent home, not shown the page
  expect(problems).toEqual([]);
  await other.close();
});

test('signing out returns to the sign-in page and a page address no longer opens', async ({ page }) => {
  await signIn(page, ADMIN.name, ADMIN.password);
  await expect(page.getByRole('heading', { name: 'The chain today' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'HQ sign in' })).toBeVisible();
  await page.goto('/branches');
  await expect(page.getByRole('heading', { name: 'HQ sign in' })).toBeVisible();
});
