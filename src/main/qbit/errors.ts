/**
 * Typed errors for the Viking Relay qBittorrent adapter.
 *
 * Every error carries a stable machine-readable `code` so callers (job engine,
 * renderer) can branch without string matching on messages.
 */

export type QbitErrorCode =
  | 'QBIT_UNREACHABLE'
  | 'QBIT_UNSUPPORTED_VERSION'
  | 'QBIT_AUTH_FAILED'
  | 'QBIT_API_ERROR'
  | 'TORRENT_SOURCE_INVALID'
  | 'METADATA_UNAVAILABLE'
  | 'METADATA_MALFORMED'
  | 'DUPLICATE_UNMANAGED_TORRENT'
  | 'TORRENT_ERRORED'
  | 'OWNERSHIP_MISMATCH'
  | 'INTAKE_NOT_FOUND'
  | 'SELECTION_INVALID'
  | 'SELECTION_NOT_APPLIED'
  | 'VALIDATION_FAILED';

export class QbitError extends Error {
  readonly code: QbitErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: QbitErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** qBittorrent WebUI could not be reached (connection refused, DNS, timeout). */
export class QbitUnreachableError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('QBIT_UNREACHABLE', message, details);
  }
}

/** Connected qBittorrent/WebAPI version is below the supported minimum. */
export class QbitUnsupportedVersionError extends QbitError {
  constructor(
    message: string,
    details: { qbtVersion?: string; webapiVersion?: string; minimumWebApiVersion: string },
  ) {
    super('QBIT_UNSUPPORTED_VERSION', message, details);
  }
}

/** Bad API key or rejected credentials (HTTP 403 from the WebUI). */
export class QbitAuthError extends QbitError {
  constructor(message = 'qBittorrent rejected the provided credentials/API key') {
    super('QBIT_AUTH_FAILED', message);
  }
}

/** WebUI returned an unexpected non-OK response. */
export class QbitApiError extends QbitError {
  constructor(
    message: string,
    details: { status: number; statusText: string; endpoint: string },
  ) {
    super('QBIT_API_ERROR', message, details);
  }
}

/** Magnet URI or HTTP(S) .torrent URL could not be parsed/validated. */
export class InvalidTorrentSourceError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('TORRENT_SOURCE_INVALID', message, details);
  }
}

/** Metadata never became available within the inspection window. */
export class MetadataUnavailableError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('METADATA_UNAVAILABLE', message, details);
  }
}

/** Metadata arrived but is unusable (no files, no name, unparsable shape). */
export class MalformedMetadataError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('METADATA_MALFORMED', message, details);
  }
}

/**
 * An identical torrent (same info hash) already exists in qBittorrent but is
 * NOT owned by Viking Relay. We refuse to commandeer it; the user must remove
 * it manually before retrying.
 */
export class DuplicateUnmanagedTorrentError extends QbitError {
  constructor(message: string, details: { infoHash: string } & Record<string, unknown>) {
    super('DUPLICATE_UNMANAGED_TORRENT', message, details);
  }
}

/** qBittorrent itself reports the torrent in an errored state. */
export class QbitTorrentErroredError extends QbitError {
  constructor(message: string, details: { infoHash: string; rawState: string }) {
    super('TORRENT_ERRORED', message, details);
  }
}

/**
 * A destructive operation was attempted against a torrent whose identity,
 * ownership tag/category, or save path does not match the supplied proof.
 * Never delete or mutate an unrelated torrent.
 */
export class OwnershipMismatchError extends QbitError {
  constructor(message: string, details: Record<string, unknown>) {
    super('OWNERSHIP_MISMATCH', message, details);
  }
}

/** An intake token referenced by commit no longer resolves to a live torrent. */
export class IntakeNotFoundError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTAKE_NOT_FOUND', message, details);
  }
}

/** Selected file indexes are empty, duplicated, or outside the file list. */
export class SelectionInvalidError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SELECTION_INVALID', message, details);
  }
}

/**
 * qBittorrent did not reflect the requested priorities after filePrio calls
 * (e.g. server-side filename filtering). The torrent is NOT started in this
 * state — starting could download deselected files.
 */
export class SelectionNotAppliedError extends QbitError {
  constructor(message: string, details: Record<string, unknown>) {
    super('SELECTION_NOT_APPLIED', message, details);
  }
}

/** Generic input validation failure (bad job id, empty save path, ...). */
export class ValidationError extends QbitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, details);
  }
}
