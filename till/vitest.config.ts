import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const shared = (p: string) => fileURLToPath(new URL('./shared/src/' + p, import.meta.url));
const alias = {
  '@pos/shared/money': shared('money.ts'),
  '@pos/shared/pricing': shared('pricing.ts'),
  '@pos/shared/barcode': shared('barcode.ts'),
  '@pos/shared/receipt': shared('receipt.ts'),
  '@pos/shared/translit': shared('translit.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { extends: true, test: { name: 'web', include: ['web/tests/**/*.test.ts'] } },
      { extends: true, test: { name: 'agent', include: ['agent/tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 180_000 } },
    ],
  },
});
