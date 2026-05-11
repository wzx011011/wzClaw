import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// E2E session tests need relay server — only run via `npm run test:e2e:session`
const excludeE2e = !process.env.VITEST_E2E_SESSION

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: excludeE2e ? ['src/main/__tests__/e2e-session/**'] : [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/**/types.ts',
        'src/main/index.ts',
      ],
    },
  }
})
