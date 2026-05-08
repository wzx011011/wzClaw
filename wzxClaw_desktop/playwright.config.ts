import { defineConfig } from '@playwright/test'
import path from 'path'

export default defineConfig({
  testDir: './test/smoke',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1, // Electron apps must not run in parallel
  use: {
    // Shared across all tests via fixture in spec file
  },
  reporter: [['list'], ['json', { outputFile: '.playwright-results/results.json' }]],
  outputDir: '.playwright-results/artifacts',
})
