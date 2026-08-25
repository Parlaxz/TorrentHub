import { test, expect } from '@playwright/test'
import { launchServer, pairClient, E2E_MAGNET, type ServerCluster } from './harness/cluster'

/** Temporary cluster smoke — validates shared fixtures before lane dispatch. */

let server: ServerCluster

test.afterEach(async () => {
  if (server) await server.close()
})

test('CLUSTER-SMOKE: server relay + paired client + intake round trip', async () => {
  server = await launchServer({ testId: 'CLUSTER-SMOKE', label: 'smoke-server' })
  // Relay is listening on the pinned LAN address
  const health = (await server.app.serverBridge<Record<string, unknown>>('getHealth()')) as Record<string, unknown>
  expect(health['online']).toBe(true)

  const client = await pairClient({ testId: 'CLUSTER-SMOKE', server })
  try {
    // Submit an intake through the real HomeScreen UI.
    await client.app.waitFor('home screen visible', async () => {
      return (await client.app.page.getByPlaceholder(/magnet/i).count()) > 0 ||
             (await client.app.page.getByText(/magnet/i).first().isVisible().catch(() => false))
    })
    await client.app.marker('submitting-intake')
    const input = client.app.page.getByLabel('Torrent magnet link or URL')
    await input.fill(E2E_MAGNET)
    await client.app.page.getByRole('button', { name: 'Continue' }).click()
    // Metadata screen should appear with the torrent name from the mock.
    await expect(client.app.page.getByText(/Movie 2024/i).first()).toBeVisible({ timeout: 20_000 })
  } finally {
    await client.close()
  }
})
