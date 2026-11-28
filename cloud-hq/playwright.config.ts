import { defineConfig, devices } from '@playwright/test';

const PORT = 4100;

// Drives the BUILT HQ screen in a real browser, against a throwaway HQ (src/cli/e2e-server.ts: a temporary database that disappears when the run ends).
// The specs share that one server and run in order, one file at a time.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: 'npm run build && npm run e2e-server',
    url: `http://127.0.0.1:${PORT}/api/v1/healthz`,
    env: { E2E_HQ_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
