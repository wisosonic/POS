import { test, expect, type Page } from '@playwright/test';

// US-37: English or Arabic. A switch in the header (and on the sign-in page) and a Language page in Settings; the choice is kept in
// this browser, Arabic reads right to left, and receipts stay in English letters. Same throwaway stack as the other specs.
async function signIn(page: Page, user: 'cashier' | 'admin' = 'cashier') {
  await page.goto('/login');
  await page.getByLabel(/Username|اسم المستخدم/).fill(user);
  await page.getByLabel(/^Password|كلمة المرور/).fill(`test-${user}-pass`);
  await page.getByRole('button', { name: /Sign in|تسجيل الدخول/ }).click();
  const open = page.getByRole('button', { name: /Open register|فتح الصندوق/ });
  await expect(open.or(page.getByTestId('checkout'))).toBeVisible();
  if (await open.isVisible()) {
    await page.getByLabel(/Cash LBP|نقداً LBP/).fill('1000000');
    await open.click();
    await expect(page.getByTestId('checkout')).toBeVisible();
  }
}
const html = (page: Page) => page.locator('html');
const toggle = (page: Page) => page.getByRole('switch');

test('US-37: the sign-in page has the switch; Arabic turns the page right to left, and it is kept after a reload', async ({ page }) => {
  await page.goto('/login');
  await expect(html(page)).toHaveAttribute('lang', 'en');
  await expect(html(page)).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await expect(html(page)).toHaveAttribute('lang', 'ar');
  await expect(html(page)).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
  await expect(page.getByLabel('اسم المستخدم')).toBeVisible();

  await page.reload();
  await expect(html(page)).toHaveAttribute('dir', 'rtl'); // kept, and applied before the first screen
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();

  await toggle(page).click(); // and back
  await expect(html(page)).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('US-37: the header switch changes the till, the menu and the cart to Arabic and back, with prices left as they are', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();

  await toggle(page).click(); // the switch sits in the header, beside the settings button
  await expect(html(page)).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'الإعدادات', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'القائمة' })).toBeVisible();
  await expect(page.getByText('السلة فارغة')).toBeVisible(); // "Cart is empty"
  await expect(page.getByRole('button', { name: /دفع/ })).toBeVisible(); // PAY

  // the menu, in Arabic, in the order it always has
  await page.getByRole('button', { name: 'القائمة' }).click();
  const menu = page.getByRole('navigation', { name: 'القائمة' });
  for (const label of ['البيع', 'المبيعات', 'المرتجعات', 'حسابات الزبائن', 'الديون'])
    await expect(menu.getByRole('link', { name: label })).toBeVisible();
  await page.keyboard.press('Escape');

  // a sale in Arabic: the prices are the same numbers
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type('5287000107945', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/75,000/);
  await page.getByRole('button', { name: /دفع/ }).click();
  const pay = page.getByRole('dialog', { name: 'الدفع' });
  await expect(pay).toContainText('المبلغ المستحق');
  await expect(pay.getByTestId('pay-total')).toHaveText(/75,000/);
  await expect(pay.getByRole('tab', { name: 'نقداً' })).toHaveAttribute('aria-selected', 'true');
  await pay.getByLabel('نقداً LBP').fill('100000');
  await expect(pay.getByTestId('change-due')).toHaveText(/25,000/);
  await pay.getByRole('button', { name: 'إتمام' }).click();
  await expect(page.getByText(/اكتمل البيع رقم \d+/)).toBeVisible();

  await toggle(page).click(); // back to English
  await expect(html(page)).toHaveAttribute('dir', 'ltr');
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();
});

test('US-37: Settings has a Language page with English and Arabic; the choice agrees with the header switch', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Language' }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  const english = page.getByRole('radio', { name: /English/ });
  const arabic = page.getByRole('radio', { name: /العربية/ });
  await expect(english).toBeChecked();

  await arabic.check();
  await expect(html(page)).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'اللغة' })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true'); // the header switch follows
  await expect(page.getByRole('navigation', { name: 'الإعدادات' }).getByRole('link', { name: 'المظهر' })).toBeVisible();

  await page.reload();
  await expect(html(page)).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('radio', { name: /العربية/ })).toBeChecked();

  await page.getByRole('radio', { name: /English|الإنجليزية/ }).check();
  await expect(html(page)).toHaveAttribute('dir', 'ltr');
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
});

test('US-37: what has no Arabic yet stays in English instead of going blank', async ({ page }) => {
  await signIn(page, 'admin');
  await toggle(page).click();
  await page.goto('/products/lists'); // a screen that is not translated yet
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Brands' })).toBeVisible();
  await expect(html(page)).toHaveAttribute('dir', 'rtl'); // laid out right to left all the same
});
