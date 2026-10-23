import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'Uploads/**',
      'POSDB.sql',
      'docs/mockups/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: "No `any` without a comment". Use an eslint-disable-next-line with a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['tests/**/*.js', 'tests/load/**'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly' } },
  },
  {
    // The load test is a command-line tool: printing its progress is its job.
    files: ['tests/load/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // The service worker runs in the browser's worker scope, not in Node or a page.
    files: ['apps/web/sw.template.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', Response: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Plain Node scripts at the top of the project (the one-terminal launcher).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', setTimeout: 'readonly', AbortSignal: 'readonly' },
    },
  },
  prettier,
);
