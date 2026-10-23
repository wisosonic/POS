import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_PORT = 3100;
const PROD_PORT = 3300;
const TABLET_API_PORT = 3200; // the tablet project gets its own API and web server, so it starts from a fresh database
const TABLET_WEB_PORT = 5174;
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } };
// A tablet held sideways (touch, 1024 x 768): the till screens must fit and every button must be reachable by finger.
const tablet = { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 }, hasTouch: true };

// Starts a throwaway API (seeded test database, fake printer) and the web app in front of it, then drives a real browser.
// Nothing here touches real data: the database is a temporary file that disappears when the run ends.
//
// Two ways of looking at the same app:
//  - till-1366x768: the Vite dev server in front of the API (fast, what most tests use)
//  - tablet-1024x768: the till-critical specs again on a touch tablet's screen (its own API and web server, so a fresh database)
//  - production-build: the BUILT app served by the API itself, with the security headers it will really have
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false, // one till, one register session, tests share the server
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'npx tsx apps/api/src/cli/e2e-server.ts',
      url: `http://127.0.0.1:${API_PORT}/api/v1/healthz`,
      env: { E2E_API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @pos/web',
      url: 'http://localhost:5173',
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx tsx apps/api/src/cli/e2e-server.ts',
      url: `http://127.0.0.1:${TABLET_API_PORT}/api/v1/healthz`,
      env: { E2E_API_PORT: String(TABLET_API_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @pos/web',
      url: `http://localhost:${TABLET_WEB_PORT}`,
      env: { API_URL: `http://127.0.0.1:${TABLET_API_PORT}`, WEB_PORT: String(TABLET_WEB_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Its own database, so the two never share a register or a sale.
      command: 'npm run build && npx tsx apps/api/src/cli/e2e-server.ts',
      url: `http://127.0.0.1:${PROD_PORT}/api/v1/healthz`,
      env: { E2E_API_PORT: String(PROD_PORT), E2E_WEB_DIST: resolve('apps/web/dist') },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'till-1366x768', use: desktop },
    {
      name: 'tablet-1024x768',
      use: { ...tablet, baseURL: `http://localhost:${TABLET_WEB_PORT}` },
      testMatch: [
        'checkout.spec.ts',
        'discount.spec.ts',
        'sales-screen.spec.ts',
        'void-price.spec.ts',
        'switch-cashier.spec.ts',
        'users.spec.ts',
      ],
    },
    { name: 'production-build', testDir: 'tests/e2e-prod', use: { ...desktop, baseURL: `http://localhost:${PROD_PORT}` } },
  ],
});
