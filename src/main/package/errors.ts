export class PackagingError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidPackagingRequestError extends PackagingError {
  constructor(message: string) {
    super('INVALID_PACKAGING_REQUEST', message);
  }
}

export class SelectedSourceMissingError extends PackagingError {
  readonly sourcePath: string;

  constructor(sourcePath: string, options?: { cause?: unknown }) {
    super('SELECTED_SOURCE_MISSING', `Selected file is missing: "${sourcePath}"`, options);
    this.sourcePath = sourcePath;
  }
}

export class SourceNotRegularFileError extends PackagingError {
  readonly sourcePath: string;

  constructor(sourcePath: string, reason: string) {
    super(
      'SOURCE_NOT_REGULAR_FILE',
      `Selected source is not a regular file (${reason}): "${sourcePath}"`,
    );
    this.sourcePath = sourcePath;
  }
}

export class SourceSizeMismatchError extends PackagingError {
  readonly sourcePath: string;
  readonly expectedBytes: number;
  readonly actualBytes: number;

  constructor(sourcePath: string, expectedBytes: number, actualBytes: number) {
    super(
      'SOURCE_SIZE_MISMATCH',
      `Source size mismatch for "${sourcePath}": expected ${expectedBytes} bytes, found ${actualBytes}`,
    );
    this.sourcePath = sourcePath;
    this.expectedBytes = expectedBytes;
    this.actualBytes = actualBytes;
  }
}

export class UnsafeArchivePathError extends PackagingError {
  readonly archiveRelativePath: string;
  readonly reason: string;

  constructor(archiveRelativePath: string, reason: string) {
    super(
      'UNSAFE_ARCHIVE_PATH',
      `Unsafe archive path "${archiveRelativePath}": ${reason}`,
    );
    this.archiveRelativePath = archiveRelativePath;
    this.reason = reason;
  }
}

export class ZipStreamError extends PackagingError {
  readonly phase: 'stream' | 'finalize';

  constructor(phase: 'stream' | 'finalize', options?: { cause?: unknown }) {
    super(
      phase === 'stream' ? 'ZIP_STREAM_FAILURE' : 'ZIP_FINALIZE_FAILURE',
      phase === 'stream'
        ? 'ZIP stream failed while writing the archive'
        : 'ZIP finalization failed',
      options,
    );
    this.phase = phase;
  }
}

export class RenameFailedError extends PackagingError {
  readonly fromPath: string;
  readonly toPath: string;

  constructor(fromPath: string, toPath: string, options?: { cause?: unknown }) {
    super('RENAME_FAILED', `Failed to rename "${fromPath}" to "${toPath}"`, options);
    this.fromPath = fromPath;
    this.toPath = toPath;
  }
}

export class PackagingCancelledError extends PackagingError {
  constructor() {
    super('PACKAGING_CANCELLED', 'Packaging was cancelled');
  }
}
