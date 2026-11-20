import { z } from 'zod'
import { JobGoalSchema, JobSnapshotSchema } from './domain'

// ---------------------------------------------------------------------------
// Route table — the CANONICAL wire API served by the relay (A6) and consumed
// by the Client PC's main-process HTTP client. There is no competing /api set.
// ---------------------------------------------------------------------------

export const ApiRoutes = {
  health: '/v1/health',
  pair: '/v1/pair',
  intakes: '/v1/intakes',
  intakeById: (intakeId: string): string => `/v1/intakes/${encodeURIComponent(intakeId)}`,
  jobPreflight: '/v1/jobs/preflight',
  jobs: '/v1/jobs',
  jobById: (jobId: string): string => `/v1/jobs/${encodeURIComponent(jobId)}`,
  cancelJob: (jobId: string): string => `/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
  dismissJob: (jobId: string): string => `/v1/jobs/${encodeURIComponent(jobId)}/dismiss`,
  discardJob: (jobId: string): string => `/v1/jobs/${encodeURIComponent(jobId)}/discard`,
  retryPackaging: (jobId: string): string =>
    `/v1/jobs/${encodeURIComponent(jobId)}/retry-packaging`,
  retryUpload: (jobId: string): string => `/v1/jobs/${encodeURIComponent(jobId)}/retry-upload`,
  recheckStorage: (jobId: string): string =>
    `/v1/jobs/${encodeURIComponent(jobId)}/recheck-storage`,
  orders: '/v1/orders',
  orderPreflight: '/v1/orders/preflight',
  history: '/v1/history',
  serverStatus: '/v1/server/status',
  clients: '/v1/clients',
  directJobs: '/v1/direct-jobs',
  directJobsSent: '/v1/direct-jobs/sent',
  directJobById: (id: string): string => `/v1/direct-jobs/${encodeURIComponent(id)}`,
  directJobDismiss: (id: string): string =>
    `/v1/direct-jobs/${encodeURIComponent(id)}/dismiss`,
  directJobReport: (id: string): string => `/v1/direct-jobs/${encodeURIComponent(id)}/report`,
  directJobAction: (id: string, action: 'accept' | 'decline'): string =>
    `/v1/direct-jobs/${encodeURIComponent(id)}/${action}`
} as const

/** Base URL of a relay endpoint, e.g. `http://26.14.203.87:47821`. */
export function relayBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

// ---------------------------------------------------------------------------
// Error envelope (as produced by the relay's error handler)
// ---------------------------------------------------------------------------

export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'validation_error',
  'unauthorized',
  'not_found',
  'job_not_found',
  'job_conflict',
  'invalid_code',
  'expired_code',
  'rate_limited',
  'payload_too_large',
  'internal_error'
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const ApiErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  retryAfterMs: z.number().int().min(0).optional()
})
export type ApiError = z.infer<typeof ApiErrorSchema>

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  ok: z.literal(true)
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export const PairRequestSchema = z.object({
  code: z.string().min(6).max(10),
  name: z.string().min(1).max(64).optional()
})
export type PairRequest = z.infer<typeof PairRequestSchema>

export const PairResponseSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  /** Raw permanent bearer token; returned exactly once. Main stores it via safeStorage. */
  token: z.string().min(1)
})
export type PairResponse = z.infer<typeof PairResponseSchema>

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export const CreateIntakeRequestSchema = z.object({
  source: z.object({ kind: z.enum(['magnet', 'url']), value: z.string().min(1) }),
  idempotencyKey: z.string().min(1).max(128).nullish()
})
export type CreateIntakeRequest = z.infer<typeof CreateIntakeRequestSchema>

export const IntakeAcceptedSchema = z.object({
  intakeId: z.string().min(1)
})
export type IntakeAccepted = z.infer<typeof IntakeAcceptedSchema>

/** GET /v1/intakes/:id responds with an IntakeDraftView. */

// ---------------------------------------------------------------------------
// Job creation and queries
// ---------------------------------------------------------------------------

export const CreateJobRequestSchema = z.object({
  intakeId: z.string().min(1),
  selection: z.array(z.number().int().min(0)).min(1).optional(),
  zipRequired: z.boolean().nullish(),
  goal: JobGoalSchema.optional(),
  cleanup: z
    .object({
      deleteTorrent: z.boolean().optional(),
      deleteFiles: z.boolean().optional(),
      deleteZip: z.boolean().optional()
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(128).nullish()
})
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>

/** Ad-hoc storage check before committing a selection or a bundle order. */
export const JobPreflightRequestSchema = z.object({
  intakeId: z.string().min(1),
  selection: z.array(z.number().int().min(0)).min(1),
  goal: JobGoalSchema.optional()
})
export type JobPreflightRequest = z.infer<typeof JobPreflightRequestSchema>

export const OrderPreflightRequestSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(50)
})
export type OrderPreflightRequest = z.infer<typeof OrderPreflightRequestSchema>

export const CreateOrderRequestSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(50),
  cleanup: z
    .object({
      deleteTorrent: z.boolean().optional(),
      deleteFiles: z.boolean().optional(),
      deleteZip: z.boolean().optional()
    })
    .optional()
})
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>

/**
 * POST /v1/jobs responds with the job snapshot plus an optional authoritative
 * storage preflight verdict. When Start is blocked for insufficient disk the
 * response still carries the preflight figures (blocked=true, missingBytes)
 * while the job remains awaiting_selection.
 */
export const CreateJobResponseSchema = z.object({
  ...JobSnapshotSchema.shape,
  storagePreflight: z.unknown().nullable().optional()
})

export const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50)
})
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>

export const HistoryResponseSchema = z.object({
  history: z.array(JobSnapshotSchema)
})
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>

export const JobsListResponseSchema = z.object({
  jobs: z.array(JobSnapshotSchema)
})

export const ServerStatusResponseSchema = z.object({
  ok: z.boolean(),
  server: z.object({ name: z.string(), version: z.string() }),
  transport: z.unknown().nullable(),
  pairedClients: z.number().int().min(0),
  /** Authenticated caller, when the request is bearer-authenticated. */
  clientId: z.string().min(1).optional(),
  time: z.string()
})
export type ServerStatusResponse = z.infer<typeof ServerStatusResponseSchema>

/** GET/POST job endpoints respond with a JobSnapshot. */
