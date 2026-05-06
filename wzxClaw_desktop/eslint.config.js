import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'scripts/**',
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript files — main process + shared
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/main/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
  })),

  // TypeScript + React — renderer
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/renderer/**/*.{ts,tsx}'],
  })),

  // Main process + shared
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'off',
    },
  },

  // Renderer (React)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Test files — relaxed rules
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
