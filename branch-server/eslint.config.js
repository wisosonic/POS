import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Code-style rules of the branch server. Each project carries its own copy of the shared part (docs/11-multi-branch.md §8.2).
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'backups/**', 'coverage/**', 'test-results/**'],
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
    // The database seam (docs/11-multi-branch.md §4): application code must not import a database library, so that a server
    // can move from SQLite to PostgreSQL by changing the driver only. Only `db/` (the drivers) and the tools below, which
    // work on the database FILE itself (backup, restore checks, rehearsal), may. This list only ever shrinks.
    files: ['src/**/*.ts'],
    ignores: ['src/db/**', 'src/backup/backup.ts', 'src/cli/backup.ts', 'src/cli/preflight.ts', 'src/cli/rehearse.ts'],
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
      'src/modules/holds/**/*.ts',
      'src/modules/sales/**/*.ts',
      'src/modules/returns/**/*.ts',
      'src/modules/customers/**/*.ts',
      'src/modules/expenses/**/*.ts',
      'src/modules/services/**/*.ts',
      'src/modules/registers/**/*.ts',
      'src/modules/wallets/**/*.ts',
      'src/modules/purchases/**/*.ts',
      'src/modules/inventory/**/*.ts',
      'src/modules/terminals/**/*.ts',
      'src/auth/approvals.ts',
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
