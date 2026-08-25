import { defineConfig } from '@playwright/test'

/**
 * E2E campaign configuration.
 * - workers=1: Electron instances are heavy; multi-instance scenarios run
 *   several apps INSIDE one test instead of parallel workers.
 * - retries=0: flake protocol is explicit (docs/E2E-FLAKE-REPORT.md), never hidden.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './artifacts/e2e/.pw-output',
  timeout: 90_000,
  globalTimeout: 60 * 60_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: './artifacts/e2e/report.json' }],
    ['junit', { outputFile: './artifacts/e2e/report.xml' }]
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  }
})
