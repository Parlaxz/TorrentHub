import type { CleanupPolicy, IntakeDraftView, IntakeSource, JobRecord } from "../jobs/types.js";
import { ServiceError } from "./http/errors.js";

export interface CreateIntakeInput {
  source: IntakeSource;
  idempotencyKey?: string | null;
  /**
   * Paired client creating the intake (tenant attribution). null/undefined
   * means server-local creation (Dashboard), which is not tenant-scoped.
   */
  clientId?: string | null;
}

export interface CreateJobInput {
  intakeId: string;
  selection?: number[] | null;
  zipRequired?: boolean | null;
  idempotencyKey?: string | null;
  /** Per-job cleanup overrides; unset keys fall back to server defaults. */
  cleanup?: Partial<CleanupPolicy> | null;
  /** Paired client committing the selection; used to enforce intake ownership. */
  clientId?: string | null;
}

/**
 * Port implemented by the A5 job engine. The relay HTTP layer depends only on
 * this interface; the concrete engine is injected by Electron main.
 *
 * Tenant scoping: every read/list/mutation method takes an optional
 * `clientId`. When a clientId is supplied, only records attributed to that
 * client are readable or mutable — records without attribution (server-local
 * / pre-upgrade) are invisible to paired clients. When omitted (server
 * Dashboard), ALL records are accessible.
 */
export interface JobService {
  createIntake(input: CreateIntakeInput): Promise<IntakeDraftView>;
  getIntake(intakeId: string, clientId?: string | null): Promise<IntakeDraftView | null>;
  createJob(input: CreateJobInput): Promise<JobRecord>;
  listJobs(clientId?: string | null): Promise<JobRecord[]>;
  getJob(jobId: string, clientId?: string | null): Promise<JobRecord | null>;
  cancelJob(jobId: string, clientId?: string | null): Promise<JobRecord>;
  retryPackaging(jobId: string, clientId?: string | null): Promise<JobRecord>;
  retryUpload(jobId: string, clientId?: string | null): Promise<JobRecord>;
  recheckStorage(jobId: string, clientId?: string | null): Promise<JobRecord>;
  listHistory(limit?: number, clientId?: string | null): Promise<JobRecord[]>;
}

export function jobNotFound(jobId: string): ServiceError {
  return new ServiceError(404, "job_not_found", `job ${jobId} not found`);
}

export function jobConflict(jobId: string, reason: string): ServiceError {
  return new ServiceError(409, "job_conflict", `job ${jobId}: ${reason}`);
}
