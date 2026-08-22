/** Typed errors for the A5 job engine. */

export class JobEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobEngineError";
  }
}

/** Thrown when Start/commit is rejected because peak disk space is unsafe. */
export class InsufficientSpaceError extends JobEngineError {
  readonly freeBytes: number | null;
  readonly requiredBytes: number;
  constructor(message: string, requiredBytes: number, freeBytes: number | null) {
    super(message);
    this.name = "InsufficientSpaceError";
    this.requiredBytes = requiredBytes;
    this.freeBytes = freeBytes;
  }
}

/** Thrown on invalid transitions (e.g. commit without selection, retry in wrong state). */
export class InvalidTransitionError extends JobEngineError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

/** Thrown when a job id does not exist. */
export class JobNotFoundError extends JobEngineError {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
  }
}
