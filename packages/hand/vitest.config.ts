import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'docker-entry.test.ts', 'src/config/**/*.test.ts', 'src/mcp/**/*.test.ts'],
  },
})
