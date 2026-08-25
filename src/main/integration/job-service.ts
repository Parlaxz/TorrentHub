/**
 * A5 → A6 JobService adapter.
 *
 * Implements the relay's JobService port over the real JobEngine and maps
 * engine records onto PUBLIC job snapshots: server-local filesystem paths
 * (job/download/package dirs, archive/source paths, torrent ids, idempotency
 * keys) are stripped before anything reaches the wire. Typed engine errors
 * map to structured service errors:
 *   missing job            → 404 job_not_found
 *   invalid transition     → 409 job_conflict
 *   insufficient disk      → handled inline (Start stays uncommitted; the
 *                            response carries the authoritative preflight)
 */
import {
  InsufficientSpaceError,
  InvalidTransitionError,
  JobNotFoundError,
  type JobEngine,
} from '../jobs';
import { isTerminalJobState } from '../jobs';
import type { IntakeDraftView, JobRecord } from '../jobs/types';
import { jobConflict, jobNotFound, type CreateIntakeInput, type CreateJobInput, type JobService } from '../relay/jobService';

/** Public job snapshot — the only job shape that ever leaves the process. */
export type PublicJobSnapshot = Omit<
  JobRecord,
  | 'jobDir'
  | 'downloadDir'
  | 'packageDir'
  | 'zipPath'
  | 'directSourcePath'
  | 'completedFiles'
  | 'torrentId'
  | 'sessionEpoch'
  | 'idempotencyKey'
  | 'startIdempotencyKey'
> & {
  /** Authoritative storage preflight verdict (set at Start/commit time). */
  storagePreflight?: JobRecord['preflight'] | null;
};

const INTAKE_STATES = new Set(['reading_metadata', 'awaiting_selection', 'failed']);

/**
 * Tenant visibility: a clientId-scoped caller sees ONLY records attributed to
 * that client. Records without attribution (server-local or pre-upgrade
 * history files) are visible exclusively to the server Dashboard, which calls
 * with no clientId.
 */
function isVisible(record: JobRecord, clientId?: string | null): boolean {
  if (clientId == null) return true;
  return record.clientId === clientId;
}

export class EngineJobService implements JobService {
  constructor(private readonly engine: JobEngine) {}

  async createIntake(input: CreateIntakeInput): Promise<IntakeDraftView> {
    const record = await this.engine.createIntake(
      input.source.value,
      input.idempotencyKey ?? null,
      input.clientId ?? null,
    );
    return toDraftView(record);
  }

  async getIntake(intakeId: string, clientId?: string | null): Promise<IntakeDraftView | null> {
    let record: JobRecord;
    try {
      record = await this.engine.getJob(intakeId);
    } catch {
      return null;
    }
    if (!isVisible(record, clientId)) return null;
    // 'failed' is part of the draft contract (IntakeDraftView['state']): an
    // intake whose metadata read failed must reach the client so it can show
    // the error screen instead of spinning on "reading metadata" forever.
    if (!INTAKE_STATES.has(record.state)) return null;
    return toDraftView(record);
  }

  async createJob(input: CreateJobInput): Promise<PublicJobSnapshot> {
    // Ownership check: a paired client may only commit a selection on an
    // intake it created itself. Anything else (other tenant's intake, or an
    // unattributed/legacy record) reads as not found.
    if (input.clientId != null) {
      let intake: JobRecord;
      try {
        intake = await this.engine.getJob(input.intakeId);
      } catch (error) {
        if (error instanceof JobNotFoundError) throw jobNotFound(input.intakeId);
        throw error;
      }
      if (!isVisible(intake, input.clientId)) throw jobNotFound(input.intakeId);
    }
    const selection = input.selection ?? [];
    try {
      const record = await this.engine.commitSelection(
        input.intakeId,
        selection,
        input.idempotencyKey ?? null,
        input.cleanup ?? null,
      );
      return toPublicJob(record);
    } catch (error) {
      if (error instanceof InsufficientSpaceError) {
        // Start blocked: the job stays awaiting_selection so the user can
        // retry once space is freed. Respond with the record plus the
        // authoritative blocked preflight instead of a transport error.
        const record = await this.engine.getJob(input.intakeId);
        return toPublicJob(record);
      }
      throw error;
    }
  }

  async listJobs(clientId?: string | null): Promise<PublicJobSnapshot[]> {
    const jobs = await this.engine.listJobs();
    return jobs.filter((j) => isVisible(j, clientId)).map(toPublicJob);
  }

  async getJob(jobId: string, clientId?: string | null): Promise<PublicJobSnapshot | null> {
    try {
      const record = await this.engine.getJob(jobId);
      if (!isVisible(record, clientId)) return null;
      return toPublicJob(record);
    } catch (error) {
      if (error instanceof JobNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Mutation ownership precheck: a paired client may only mutate records
   * attributed to itself. Anything else (another tenant's job, or an
   * unattributed/legacy record) reads as not found — same rule and same
   * 404 shape as the createJob intake precheck, so existence is never leaked.
   */
  private async assertMutableBy(jobId: string, clientId?: string | null): Promise<void> {
    if (clientId == null) return;
    let record: JobRecord;
    try {
      record = await this.engine.getJob(jobId);
    } catch (error) {
      if (error instanceof JobNotFoundError) throw jobNotFound(jobId);
      throw error;
    }
    if (!isVisible(record, clientId)) throw jobNotFound(jobId);
  }

  async cancelJob(jobId: string, clientId?: string | null): Promise<PublicJobSnapshot> {
    await this.assertMutableBy(jobId, clientId);
    try {
      return toPublicJob(await this.engine.cancel(jobId));
    } catch (error) {
      throw translate(error, jobId);
    }
  }

  async retryPackaging(jobId: string, clientId?: string | null): Promise<PublicJobSnapshot> {
    await this.assertMutableBy(jobId, clientId);
    try {
      await this.engine.retryPackaging(jobId);
    } catch (error) {
      throw translate(error, jobId);
    }
    return toPublicJob(await this.engine.getJob(jobId));
  }

  async retryUpload(jobId: string, clientId?: string | null): Promise<PublicJobSnapshot> {
    await this.assertMutableBy(jobId, clientId);
    try {
      await this.engine.retryUpload(jobId);
    } catch (error) {
      throw translate(error, jobId);
    }
    return toPublicJob(await this.engine.getJob(jobId));
  }

  async recheckStorage(jobId: string, clientId?: string | null): Promise<PublicJobSnapshot> {
    await this.assertMutableBy(jobId, clientId);
    try {
      await this.engine.retryStorageCheck(jobId);
    } catch (error) {
      throw translate(error, jobId);
    }
    return toPublicJob(await this.engine.getJob(jobId));
  }

  async listHistory(limit?: number, clientId?: string | null): Promise<PublicJobSnapshot[]> {
    const jobs = await this.engine.listJobs();
    return jobs
      .filter((j) => isVisible(j, clientId))
      .filter((j) => isTerminalJobState(j.state))
      .slice(0, limit ?? 50)
      .map(toPublicJob);
  }
}

/* ------------------------------------------------------------------ */
/* mapping helpers                                                     */

function toDraftView(record: JobRecord): IntakeDraftView {
  return {
    id: record.id,
    state: record.state as IntakeDraftView['state'],
    metadata: record.metadata ?? null,
    error: record.error ?? null,
  };
}

/** Strips all server-local filesystem/secret fields from a job record. */
function toPublicJob(record: JobRecord): PublicJobSnapshot {
  const pub: PublicJobSnapshot = {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    source: record.source,
    clientId: record.clientId ?? null,
    selection: record.selection ?? null,
    selectedBytes: record.selectedBytes ?? null,
    zipRequired: record.zipRequired ?? null,
    metadata: record.metadata ?? null,
    stages: record.stages,
    telemetry: record.telemetry ?? null,
    storage: record.storage ?? null,
    hint: record.hint ?? null,
    packagingProgress: record.packagingProgress ?? null,
    uploadProgress: record.uploadProgress ?? null,
    preflight: record.preflight ?? null,
    result: record.result ?? null,
    error: record.error ?? null,
    lastKnownStage: record.lastKnownStage ?? null,
    storagePreflight: record.preflight ?? null,
  };
  return pub;
}

function translate(error: unknown, jobId: string): unknown {
  if (error instanceof JobNotFoundError) return jobNotFound(jobId);
  if (error instanceof InvalidTransitionError) return jobConflict(jobId, error.message);
  return error;
}
