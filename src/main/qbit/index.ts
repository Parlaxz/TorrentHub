/**
 * Viking Relay qBittorrent adapter — public surface.
 *
 * Modules:
 * - service.ts   QbitTorrentService (job-engine entry point)
 * - client.ts    QbitClient (typed WebAPI client + version gate)
 * - http.ts      fetch transport (API key / cookie auth, timeouts)
 * - inspect.ts   metadata-only inspection
 * - commit.ts    race-free selective-download commit
 * - progress.ts  progress mapping + selected-files completion
 * - lifecycle.ts guarded stop/cleanup
 * - errors.ts    typed error hierarchy
 * - types.ts     contracts (internal until shared contracts appear)
 */

export { QbitTorrentService } from './service';
export { QbitClient, compareVersions, DEFAULT_MIN_WEBAPI_VERSION } from './client';
export type { AddTorrentParams, FetchMetadataResult } from './client';
export { IntakeRegistry } from './registry';
export { classifyState, normalizeEta, normalizeSwarmCount, QBIT_ETA_INFINITY_SENTINEL } from './statemap';
export { parseTorrentSource } from './magnet';
export type { ParsedSource } from './magnet';
export { hashFromToken, mintIntakeToken } from './tokens';
export {
  INTAKE_TAG,
  TAG_PREFIX,
  findForeignJobTag,
  hasVrOwnership,
  jobTag,
  normalizePath,
  pathWithin,
  tagsOf,
  validateJobId,
  verifyOwnership,
} from './ownership';
export {
  DuplicateUnmanagedTorrentError,
  IntakeNotFoundError,
  InvalidTorrentSourceError,
  MalformedMetadataError,
  MetadataUnavailableError,
  OwnershipMismatchError,
  QbitApiError,
  QbitAuthError,
  QbitError,
  QbitTorrentErroredError,
  QbitUnreachableError,
  QbitUnsupportedVersionError,
  SelectionInvalidError,
  SelectionNotAppliedError,
} from './errors';
export type { QbitErrorCode } from './errors';
export * from './types';
