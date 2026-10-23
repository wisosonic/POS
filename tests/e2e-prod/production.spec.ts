import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// The BUILT app, served by the API itself with its real security headers (see playwright.config.ts). The question here is
// whether the Content-Security-Policy, the cookie and the caching leave the app working, not what the screens do.
const CHOC = '9342390005250';

/** Record every time the browser blocks something because of the Content-Security-Policy. */
async function watchCsp(page: Page) {
  const messages: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) messages.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return async () => [...messages, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))];
}

async function signIn(page: Page) {
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

test('the page itself comes with the security headers, and is always re-checked', async ({ page }) => {
  const res = await page.goto('/login');
  const h = res!.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cache-control']).toBe('no-cache');
});

test('a whole shift works under the policy: sign in, sell, pay, see the figures, download a report', async ({ page }) => {
  const violations = await watchCsp(page);
  await signIn(page);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(CHOC, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-row')).toHaveCount(1);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.getByLabel('Cash LBP').fill('50000');
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByText(/Sale \d+ completed/)).toBeVisible();

  await page.goto('/dashboard');
  await expect(page.getByTestId('net-today')).toBeVisible();

  await page.goto('/reports');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByTestId('report-total')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download as spreadsheet' }).click();
  const file = await download;
  expect(readFileSync((await file.path())!, 'utf8')).toContain('Day,Sales,Sold,Taken back,Net,Profit');

  expect(await violations()).toEqual([]);
});

test('a refresh on a page of the app keeps the session (the cookie works) and shows that page', async ({ page }) => {
  const violations = await watchCsp(page);
  await signIn(page);
  await page.goto('/products');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('the policy really blocks an inline script (so an empty violation list above means something)', async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto('/login');
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__ran = 1';
    document.body.append(s);
  });
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
  await expect.poll(async () => (await violations()).length).toBeGreaterThan(0);
  expect((await violations()).join(' ')).toContain('script-src');
});

test('the script cannot be injected through a product name', async ({ page }) => {
  const violations = await watchCsp(page);
  await signIn(page);
  await page.goto('/products');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Name', { exact: true }).fill('<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>');
  await page.getByLabel('Selling price').fill('1000');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('searchbox').fill('img src');
  await expect(page.getByTestId('product-row').filter({ hasText: '<img src=x' })).toHaveCount(1); // shown as text, not as an element
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await violations()).toEqual([]);
});

test('a product picture loads under the policy, and the page is not blocked from showing it', async ({ page }) => {
  const violations = await watchCsp(page);
  await signIn(page);
  await page.goto('/products');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Policy cookies');
  await page.getByLabel('Selling price').fill('1000');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Product picture file').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('searchbox').fill('Policy cookies');
  const thumb = page.getByTestId('product-row').filter({ hasText: 'Policy cookies' }).locator('img.thumb');
  await expect(thumb).toHaveAttribute('src', /^\/uploads\/[0-9a-f]{24}\.png$/);
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await violations()).toEqual([]);

  // served as a picture, cached for good, and nothing else in the folder is reachable
  const src = (await thumb.getAttribute('src'))!;
  const res = await page.request.get(src);
  expect(res.headers()['content-type']).toBe('image/png');
  expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await page.request.get('/uploads/pos.db')).status()).toBe(404);
});

test('US-10: after the till has been opened once, the app still opens with the server unreachable, and says why it cannot sign in (service worker)', async ({
  page,
  context,
}) => {
  await signIn(page);
  await expect.poll(async () => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload(); // a browser restart with the server down looks the same: the page itself cannot be fetched
  // The app comes from its saved copy. Signing in needs the server (a session cannot be renewed without it), and says so.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.goto('/sales'); // another address works the same way
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill('manager');
  await page.getByLabel('Password').fill('test-manager-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot reach the server');

  await context.setOffline(false);
});

test('the service worker never answers /api, and is itself always re-checked', async ({ page, request }) => {
  const res = await request.get('/sw.js');
  expect(res.headers()['cache-control']).toBe('no-cache');
  const source = await res.text();
  expect(source).toContain('/index.html');
  expect(source).not.toContain('__VERSION__');
  expect(source).not.toContain('__PRECACHE__');
  expect(source).toMatch(/\/api\//); // the rule that leaves the API alone
  expect((await request.get('/manifest.webmanifest')).ok()).toBe(true);
  await page.goto('/login');
});

test('the offline copy holds every screen, not only the till (the screens load on demand)', async ({ request }) => {
  const source = await (await request.get('/sw.js')).text();
  for (const screen of ['SalesPage', 'ProductsPage', 'ReportsPage', 'UsersPage', 'StocktakePage'])
    expect(source, screen).toContain(`/assets/${screen}-`);
  expect(source).toContain('.woff2'); // the fonts too
  expect(source).not.toMatch(/\.woff"/); // but not the old fallback format
  expect(source).not.toMatch(/\.js\.map"/); // no source maps
});
