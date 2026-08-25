import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type AppHandle } from './harness/app'

/**
 * SANITY lane — proves the harness itself before any product suite runs.
 * Per docs/E2E-EXHAUSTIVE-TEST-PLAN.md §1.8: if these fail, STOP and fix the harness.
 */

const launched: AppHandle[] = []

async function closeAll(): Promise<void> {
  for (const a of launched) await a.close()
  launched.length = 0
}

test.afterEach(async () => {
  await closeAll()
})

test('SANITY-001: launches, bridge ready, mode chooser visible, artifacts written', async () => {
  const app = await launchApp({ testId: 'SANITY-001', label: 'fresh' })
  launched.push(app)
  await app.marker('assert-mode-chooser')
  await expect(app.page.getByText('Welcome to Viking Relay')).toBeVisible()
  const state = await app.getState()
  expect(state.mode).toBeNull()
  expect(state.versions.app).toBe('0.4.3')
  // Client + Server buttons exist
  await expect(app.page.getByRole('button', { name: /Client PC/ })).toBeVisible()
  await expect(app.page.getByRole('button', { name: /Server PC/ })).toBeVisible()
  // Artifacts survive process: written at close.
  await app.close()
  expect(existsSync(join(app.artifactsDir, 'console-fresh.log'))).toBe(true)
  expect(existsSync(join(app.artifactsDir, 'markers-fresh.json'))).toBe(true)
  expect(existsSync(join(app.artifactsDir, 'summary-fresh.json'))).toBe(true)
})

test('SANITY-002: chosen mode persists across restart (seeded persistence boundary)', async () => {
  const app = await launchApp({ testId: 'SANITY-002', label: 'first', keepUserDataOnClose: true })
  launched.push(app)
  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('mode switched to client', async () => (await app.getState()).mode === 'client')
  await app.close()

  // Restart semantics: re-seed a new isolated dir with the exact persisted bytes.
  const settingsJson = app.readPersisted('settings.json')
  expect(settingsJson).toBeTruthy()
  const restarted = await launchApp({
    testId: 'SANITY-002',
    label: 'restarted',
    settings: JSON.parse(settingsJson!) as Record<string, never>
  })
  launched.push(restarted)
  const state = await restarted.getState()
  expect(state.mode).toBe('client')
  // Fresh client with no saved connection lands on the Connect screen.
  await expect(restarted.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible()
})

test('SANITY-003: two concurrent instances are fully isolated', async () => {
  const a = await launchApp({ testId: 'SANITY-003', label: 'inst-a' })
  const b = await launchApp({ testId: 'SANITY-003', label: 'inst-b' })
  launched.push(a, b)
  await a.page.getByRole('button', { name: /Client PC/ }).click()
  await a.waitFor('a=client', async () => (await a.getState()).mode === 'client')
  // b remains unconfigured
  expect((await b.getState()).mode).toBeNull()
  expect(a.userDataDir).not.toBe(b.userDataDir)
})

test('SANITY-004: collectors capture console errors and failed requests into artifacts', async () => {
  const app = await launchApp({ testId: 'SANITY-004', label: 'collect' })
  launched.push(app)
  await app.page.evaluate(() => console.error('E2E-SANITY-MARKER-error'))
  await app.page.evaluate(() => fetch('http://127.0.0.1:9/unreachable').catch(() => undefined))
  await app.waitFor('failed request recorded', async () => app.failedRequestCount() > 0)
  await app.close()
  const consoleLog = join(app.artifactsDir, 'console-collect.log')
  expect(existsSync(consoleLog)).toBe(true)
  expect(readFileSync(consoleLog, 'utf8')).toContain('E2E-SANITY-MARKER-error')
  expect(existsSync(join(app.artifactsDir, 'failed-requests-collect.json'))).toBe(true)
})
