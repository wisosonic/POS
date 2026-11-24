import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Code-style rules of the HQ server. Each project carries its own copy of the shared part (docs/11-multi-branch.md §8.2).
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'coverage/**', 'test-results/**'],
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
  prettier,
);
