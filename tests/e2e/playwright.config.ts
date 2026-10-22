import { defineConfig } from '@playwright/test'

// End-to-end tests drive the built app (out/main/index.js) through Playwright's Electron support.
// Run `npm run build` first; on a headless Linux box wrap the run in `xvfb-run -a`.
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '../../out/e2e-results'
})
