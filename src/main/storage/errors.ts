export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class StorageUnavailableError extends StorageError {
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super('STORAGE_UNAVAILABLE', `Unable to read disk space for "${path}"`, options);
    this.path = path;
  }
}

export class InsufficientDiskSpaceError extends StorageError {
  readonly freeBytes: number;
  readonly requiredBytes: number;
  readonly deficitBytes: number;
  readonly phase: 'preflight' | 'live' | 'packaging-start';

  constructor(params: {
    phase: 'preflight' | 'live' | 'packaging-start';
    freeBytes: number;
    requiredBytes: number;
  }) {
    const deficit = params.requiredBytes - params.freeBytes;
    super(
      'INSUFFICIENT_DISK_SPACE',
      `Insufficient disk space (${params.phase}): need ${params.requiredBytes} bytes, ` +
        `${params.freeBytes} bytes free. Free at least ${deficit} more bytes, then retry the storage check.`,
    );
    this.phase = params.phase;
    this.freeBytes = params.freeBytes;
    this.requiredBytes = params.requiredBytes;
    this.deficitBytes = deficit;
  }
}
