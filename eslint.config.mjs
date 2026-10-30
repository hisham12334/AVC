import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  { files: ['**/*.cjs'], languageOptions: { globals: { module: 'readonly' } } },
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
];
