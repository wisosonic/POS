import { expect, test as base, type Page } from '@playwright/test';

export const ADMIN = { name: 'boss', password: 'Correct-Horse-Battery-9' };

/**
 * Every test fails on a script error or a console error, except the ones a refused request causes by itself ("Failed to load resource ... 401"): a wrong
 * password and a refusal HQ explains on screen are expected and checked by the tests that cause them.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`);
      });
      await use(problems);
      expect(problems, 'nothing unexpected in the browser console').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function signIn(page: Page, name: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The session token the page itself holds, for set-up the screen has no page for (an exchange rate). The token never leaves this test. */
export async function apiAs(page: Page) {
  const token = await page.evaluate(
    () => (JSON.parse(sessionStorage.getItem('hq-session') ?? 'null') as { token: string } | null)?.token ?? '',
  );
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    post: (path: string, data: unknown) => page.request.post(`/api/v1${path}`, { headers, data }),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The month before this one, as the dates a payroll test needs (UTC, like the server). */
export function lastMonth(now = new Date()) {
  const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${y}-${pad(m)}-01`, mid: `${y}-${pad(m)}-15`, last: `${y}-${pad(m)}-${pad(lastDay)}`, longAgo: `${y - 2}-01-01` };
}
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
