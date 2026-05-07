import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Error — 捕获真实 bug
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
      'no-constructor-return': 'error',
      'no-template-curly-in-string': 'error',
      'no-unsafe-negation': 'error',
      'no-useless-backreference': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // Warning — 代码质量提示，不阻塞
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // 测试文件允许 any（mock/fixture 需要）
  {
    files: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['dist/', 'out/', 'node_modules/', '**/*.js'],
  },
]
