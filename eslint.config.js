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
    files: ['branch-server/tests/**/*.js', 'branch-server/tests/load/**'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly' } },
  },
  {
    // The load test and the print agent are command-line tools: printing their progress is their job.
    files: ['branch-server/tests/load/**/*.ts', 'till/agent/src/cli.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // The service worker runs in the browser's worker scope, not in Node or a page.
    files: ['till/web/sw.template.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', Response: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Plain Node scripts at the top of the project (the one-terminal launcher).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', setTimeout: 'readonly', AbortSignal: 'readonly' },
    },
  },
  {
    // The database seam (docs/11-multi-branch.md §4): application code must not import a database library, so that a server
    // can move from SQLite to PostgreSQL by changing the driver only. Only `db/` (the drivers) and the tools below, which
    // work on the database FILE itself (backup, restore checks, rehearsal), may. This list only ever shrinks.
    files: ['branch-server/src/**/*.ts'],
    ignores: [
      'branch-server/src/db/**',
      'branch-server/src/backup/backup.ts',
      'branch-server/src/cli/backup.ts',
      'branch-server/src/cli/preflight.ts',
      'branch-server/src/cli/rehearse.ts',
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
      'branch-server/src/modules/holds/**/*.ts',
      'branch-server/src/modules/sales/**/*.ts',
      'branch-server/src/modules/returns/**/*.ts',
      'branch-server/src/modules/customers/**/*.ts',
      'branch-server/src/modules/expenses/**/*.ts',
      'branch-server/src/modules/services/**/*.ts',
      'branch-server/src/modules/registers/**/*.ts',
      'branch-server/src/modules/purchases/**/*.ts',
      'branch-server/src/modules/inventory/**/*.ts',
      'branch-server/src/modules/terminals/**/*.ts',
      'branch-server/src/auth/approvals.ts',
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
