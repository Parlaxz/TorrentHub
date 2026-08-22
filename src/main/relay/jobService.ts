import type { IntakeDraftView, IntakeSource, JobRecord } from "../jobs/types.js";
import { ServiceError } from "./http/errors.js";

export interface CreateIntakeInput {
  source: IntakeSource;
  idempotencyKey?: string | null;
}

export interface CreateJobInput {
  intakeId: string;
  selection?: number[] | null;
  zipRequired?: boolean | null;
  idempotencyKey?: string | null;
}

/**
 * Port implemented by the A5 job engine. The relay HTTP layer depends only on
 * this interface; the concrete engine is injected by Electron main.
 */
export interface JobService {
  createIntake(input: CreateIntakeInput): Promise<IntakeDraftView>;
  getIntake(intakeId: string): Promise<IntakeDraftView | null>;
  createJob(input: CreateJobInput): Promise<JobRecord>;
  listJobs(): Promise<JobRecord[]>;
  getJob(jobId: string): Promise<JobRecord | null>;
  cancelJob(jobId: string): Promise<JobRecord>;
  retryPackaging(jobId: string): Promise<JobRecord>;
  retryUpload(jobId: string): Promise<JobRecord>;
  recheckStorage(jobId: string): Promise<JobRecord>;
  listHistory(limit?: number): Promise<JobRecord[]>;
}

export function jobNotFound(jobId: string): ServiceError {
  return new ServiceError(404, "job_not_found", `job ${jobId} not found`);
}

export function jobConflict(jobId: string, reason: string): ServiceError {
  return new ServiceError(409, "job_conflict", `job ${jobId}: ${reason}`);
}
