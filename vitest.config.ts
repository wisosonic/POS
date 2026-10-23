import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const shared = (p: string) => fileURLToPath(new URL(`./packages/shared/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pos/shared/money': shared('money.ts'),
      '@pos/shared/pricing': shared('pricing.ts'),
      '@pos/shared/barcode': shared('barcode.ts'),
      '@pos/shared/receipt': shared('receipt.ts'),
      '@pos/shared/translit': shared('translit.ts'),
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'db', include: ['tests/db/**/*.test.ts'], testTimeout: 30_000 } },
      { extends: true, test: { name: 'web', include: ['tests/web/**/*.test.ts'] } },
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      { extends: true, test: { name: 'migration', include: ['tests/migration/**/*.test.ts'], testTimeout: 600_000, hookTimeout: 600_000 } },
    ],
  },
});
