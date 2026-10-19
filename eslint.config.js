import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      'presentation/**',
      'playwright-report/**',
      'test-results/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Model or tool output must never be rendered as raw HTML.',
        },
      ],
    },
  },
  {
    // Interface text lives in apps/web/src/lib/messages (English and Arabic), never in a component.
    files: ['apps/web/src/components/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Model or tool output must never be rendered as raw HTML.',
        },
        {
          selector: 'JSXText[value=/[A-Za-z]{2,}/]',
          message: 'Put interface text in apps/web/src/lib/messages and render it with t().',
        },
        {
          selector: "JSXAttribute[name.name=/^(aria-label|label|title|placeholder|alt)$/] > Literal[value=/[A-Za-z]{2,}/]",
          message: 'Put interface text in apps/web/src/lib/messages and render it with t().',
        },
      ],
    },
  },
);
