import { defineConfig } from '@playwright/test'
import path from 'path'

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  timeout: 90_000, // E2E agent tests need more time than smoke tests
  retries: 0,
  workers: 1, // Electron apps must not run in parallel
  use: {
    // Shared across all tests via fixture in spec file
  },
  reporter: [['list'], ['json', { outputFile: '.playwright-results/results.json' }]],
  outputDir: '.playwright-results/artifacts',
})
