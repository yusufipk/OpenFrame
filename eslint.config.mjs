import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated test output. These are gitignored, but eslint keeps its own
    // ignore list, and the v8 coverage reporter ships vendored JS that trips
    // `--max-warnings=0`, so a coverage run would otherwise break `bun run lint`.
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'reports/**',
    '.stryker-tmp/**',
    // Git worktrees checked out under .claude/worktrees are separate checkouts,
    // not part of this tree; linting them fails the run on their files.
    '.claude/**',
  ]),
  prettier,
  {
    // The Premiere panel runs in Adobe's UXP runtime, which loads CommonJS modules
    // and host APIs with require().
    files: ['integrations/premiere-panel/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Tests are allowed liberties that production code is not: `any` when
    // shaping a fixture, and imports that reach past the `@/` aliases into
    // test helpers. `--max-warnings=0` still applies to everything else.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },
]);

export default eslintConfig;
