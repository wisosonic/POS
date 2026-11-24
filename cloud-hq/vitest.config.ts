import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const shared = (p: string) => fileURLToPath(new URL('../branch-server/shared/src/' + p, import.meta.url));
const alias = {
  '@pos/shared/money': shared('money.ts'),
  '@pos/shared/pricing': shared('pricing.ts'),
  '@pos/shared/barcode': shared('barcode.ts'),
  '@pos/shared/receipt': shared('receipt.ts'),
  '@pos/shared/translit': shared('translit.ts'),
};

// HQ's own tests, and (for now) the system tests that start a branch server next to HQ (docs/11 §8.2: they will become process-based).
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { extends: true, test: { name: 'central', include: ['tests/*.test.ts'], testTimeout: 30_000 } },
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'system', include: ['tests/system/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 180_000 } },
    ],
  },
});
