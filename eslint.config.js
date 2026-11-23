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
  {
    // The database seam (docs/11-multi-branch.md §4): application code must not import a database library, so that a server
    // can move from SQLite to PostgreSQL by changing the driver only. Only `db/` (the drivers) and the tools below, which
    // work on the database FILE itself (backup, restore checks, rehearsal), may. This list only ever shrinks.
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/db/**',
      'apps/api/src/backup/backup.ts',
      'apps/api/src/cli/backup.ts',
      'apps/api/src/cli/preflight.ts',
      'apps/api/src/cli/rehearse.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'better-sqlite3', message: 'Use the database adapter (app.database, db/adapter.ts). See docs/11-multi-branch.md §4.' },
          ],
        },
      ],
    },
  },
  {
    // Modules already converted to the adapter must stay converted: no legacy synchronous handle, no raw SQLite helpers.
    // Add a module's folder here when it is converted.
    files: [
      'apps/api/src/modules/holds/**/*.ts',
      'apps/api/src/modules/sales/**/*.ts',
      'apps/api/src/modules/returns/**/*.ts',
      'apps/api/src/modules/customers/**/*.ts',
      'apps/api/src/modules/expenses/**/*.ts',
      'apps/api/src/modules/services/**/*.ts',
      'apps/api/src/modules/registers/**/*.ts',
      'apps/api/src/modules/purchases/**/*.ts',
      'apps/api/src/modules/inventory/**/*.ts',
      'apps/api/src/auth/approvals.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'better-sqlite3', message: 'Use the database adapter.' }],
          patterns: [
            { group: ['**/db/open'], message: 'This module uses the database adapter (db/adapter.ts), not the legacy synchronous handle.' },
          ],
        },
      ],
    },
  },
  prettier,
);
