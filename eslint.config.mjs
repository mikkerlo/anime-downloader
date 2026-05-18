import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'scripts/**',
      'src/renderer/public/**',
      '**/*.tsbuildinfo'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.{ts,mts,cts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['src/main/**', 'src/preload/**', '*.config.{ts,mts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ['src/renderer/**'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    // Rules relaxed to match the existing (pre-lint) codebase style. The goal of
    // Phase 0 is to wire linting without reformatting/refactoring application
    // logic; stricter rules can be ratcheted up in later phases.
    rules: {
      // TypeScript already resolves identifiers/types; the core rule false-flags
      // ambient types and globals. Disabled per typescript-eslint guidance.
      'no-undef': 'off',
      // Existing code (and Vue template expressions) rely on short-circuit
      // `cond && fn()` statements; not reformatting these in Phase 0.
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-v-html': 'off'
    }
  },
  prettier
)
