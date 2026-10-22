import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.int.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [['tests/unit/renderer/**', 'jsdom']],
    setupFiles: ['tests/unit/setup.ts']
  }
})
