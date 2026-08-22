import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // node:test suites (A2–A6) run via `npm run test:node|test:auth-relay|
    // test:qbit|test:viking`; jsdom is selected per-file via docblocks.
    exclude: [
      'tests/auth/**',
      'tests/integration/**',
      'tests/jobs/**',
      'tests/package/**',
      'tests/qbit/**',
      'tests/relay/**',
      'tests/storage/**',
      'tests/viking/**',
      'node_modules/**'
    ]
  }
})
