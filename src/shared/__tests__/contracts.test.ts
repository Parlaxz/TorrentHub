import { describe, expect, it } from 'vitest'
import {
  DownloadTelemetrySchema,
  IntakeDraftViewSchema,
  JobSnapshotSchema,
  PreflightViewSchema,
  StorageViewSchema,
  TorrentMetadataSchema,
  isTerminalJobState
} from '../domain'
import {
  ApiErrorSchema,
  CreateIntakeRequestSchema,
  CreateJobRequestSchema,
  HealthResponseSchema,
  HistoryQuerySchema,
  PairRequestSchema,
  PairResponseSchema,
  ServerStatusResponseSchema,
  relayBaseUrl
} from '../api'
import { AppSettingsPatchSchema, AppSettingsSchema, DEFAULT_SETTINGS } from '../settings'

const validJob = {
  id: 'job-1',
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:01:00.000Z',
  state: 'downloading',
  source: { kind: 'magnet', value: 'magnet:?xt=urn:btih:abc' },
  selection: [0, 2],
  selectedBytes: 100,
  zipRequired: true,
  metadata: {
    name: 'Linux ISO',
    infoHashV1: 'abcdef0123456789',
    files: [
      { index: 0, path: 'a/b.iso', sizeBytes: 90 },
      { index: 1, path: 'a/c.txt', sizeBytes: 10 }
    ],
    totalSizeBytes: 100
  },
  stages: { metadata: 'complete', download: 'active' },
  telemetry: {
    progressPct: 42,
    downloadedBytes: 42,
    totalSelectedBytes: 100,
    speedBps: 0,
    etaSeconds: null,
    seeds: 0,
    peers: 3,
    selectedComplete: false
  },
  storage: {
    freeBytes: 500,
    remainingDownloadBytes: 58,
    zipReservationBytes: 100,
    safetyReserveBytes: 2048,
    projectedHeadroomBytes: -1706,
    warning: 'critical'
  },
  result: null,
  error: null
}

describe('domain contracts', () => {
  it('parses torrent metadata with canonical file entries', () => {
    const parsed = TorrentMetadataSchema.parse({
      name: 'distro',
      infoHashV1: 'abcdef0123456789',
      totalSizeBytes: 100,
      files: [
        { index: 0, path: 'a/b.iso', sizeBytes: 90 },
        { index: 1, path: 'a/c.txt', sizeBytes: 10 }
      ]
    })
    expect(parsed.files).toHaveLength(2)
  })

  it('rejects metadata with a negative file size', () => {
    expect(
      TorrentMetadataSchema.safeParse({
        name: 'x',
        totalSizeBytes: 5,
        files: [{ index: 0, path: 'p', sizeBytes: -1 }]
      }).success
    ).toBe(false)
  })

  it('rejects download telemetry above 100 percent', () => {
    const base = validJob.telemetry
    expect(DownloadTelemetrySchema.safeParse({ ...base, progressPct: 100.5 }).success).toBe(false)
    expect(DownloadTelemetrySchema.safeParse(base).success).toBe(true)
  })

  it('allows negative projected headroom in storage views', () => {
    const parsed = StorageViewSchema.parse(validJob.storage)
    expect(parsed.warning).toBe('critical')
    expect(parsed.projectedHeadroomBytes).toBeLessThan(0)
  })

  it('parses the authoritative preflight view with blocked state', () => {
    const parsed = PreflightViewSchema.parse({
      selectedFiles: 2,
      selectedBytes: 100,
      tempZipBytes: 164,
      safetyReserveBytes: 2048,
      peakRequiredBytes: 2312,
      serverFreeBytes: 600,
      enough: false,
      missingBytes: 1712,
      blocked: true
    })
    expect(parsed.blocked).toBe(true)
    expect(parsed.missingBytes).toBe(1712)
  })

  it('parses an intake draft view', () => {
    const parsed = IntakeDraftViewSchema.parse({
      id: 'i-1',
      state: 'awaiting_selection',
      metadata: validJob.metadata,
      error: null
    })
    expect(parsed.state).toBe('awaiting_selection')
  })

  it('classifies terminal job states', () => {
    expect(isTerminalJobState('complete')).toBe(true)
    expect(isTerminalJobState('interrupted')).toBe(true)
    expect(isTerminalJobState('downloading')).toBe(false)
  })

  it('round-trips a full job snapshot without local filesystem paths', () => {
    const parsed = JobSnapshotSchema.parse(validJob)
    expect(parsed.id).toBe('job-1')
    expect(parsed.storage?.warning).toBe('critical')
    expect(parsed.source.kind).toBe('magnet')
  })
})

describe('api contracts (canonical /v1)', () => {
  it('exposes only /v1 routes', () => {
    expect(relayBaseUrl('26.14.203.87', 47821)).toBe('http://26.14.203.87:47821')
  })

  it('validates intake creation payloads', () => {
    expect(
      CreateIntakeRequestSchema.safeParse({
        source: { kind: 'magnet', value: 'magnet:?xt=urn:btih:abc' }
      }).success
    ).toBe(true)
    expect(
      CreateIntakeRequestSchema.safeParse({
        source: { kind: 'url', value: 'https://example.com/a.torrent' }
      }).success
    ).toBe(true)
    expect(
      CreateIntakeRequestSchema.safeParse({ source: { kind: 'ftp', value: 'ftp://x' } }).success
    ).toBe(false)
  })

  it('requires at least one selected file to create a job', () => {
    expect(CreateJobRequestSchema.safeParse({ intakeId: 'i', selection: [] }).success).toBe(false)
    expect(CreateJobRequestSchema.safeParse({ intakeId: 'i', selection: [0] }).success).toBe(true)
  })

  it('validates pairing request/response envelopes', () => {
    expect(PairRequestSchema.safeParse({ code: 'K7RM4Q2X' }).success).toBe(true)
    expect(PairRequestSchema.safeParse({ code: '' }).success).toBe(false)

    expect(
      PairResponseSchema.safeParse({ clientId: 'vrc_abcd', name: 'client-pc', token: 't' }).success
    ).toBe(true)
  })

  it('validates health and server status envelopes', () => {
    expect(HealthResponseSchema.safeParse({ ok: true }).success).toBe(true)

    expect(
      ServerStatusResponseSchema.safeParse({
        ok: true,
        server: { name: 'viking-relay', version: '0.1.0' },
        transport: null,
        pairedClients: 1,
        time: '2026-08-22T10:00:00.000Z'
      }).success
    ).toBe(true)
  })

  it('defaults history limit and parses error envelopes', () => {
    expect(HistoryQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(HistoryQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 })

    const err = ApiErrorSchema.parse({ error: 'job_not_found', message: 'no job' })
    expect(err.error).toBe('job_not_found')

    expect(
      ApiErrorSchema.safeParse({
        error: 'validation_error',
        issues: [{ path: 'source.kind', message: 'invalid' }]
      }).success
    ).toBe(true)
  })
})

describe('settings contract', () => {
  it('applies defaults for optional fields with the canonical relay port', () => {
    const settings = AppSettingsSchema.parse(DEFAULT_SETTINGS)
    expect(settings.mode).toBeNull()
    expect(settings.serverPort).toBe(47821)
  })

  it('accepts partial patches only', () => {
    expect(AppSettingsPatchSchema.safeParse({ mode: 'client' }).success).toBe(true)
    expect(AppSettingsPatchSchema.safeParse({ mode: 'router' }).success).toBe(false)
    expect(AppSettingsPatchSchema.safeParse({ serverPort: 99999 }).success).toBe(false)
  })
})
