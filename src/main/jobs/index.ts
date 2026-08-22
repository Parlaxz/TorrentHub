/** Public surface of the A5 job engine for the integration layer. */
export { JobEngine, type JobEngineDeps } from "./engine.ts";
export { TransferPipeline, type CancelOptions } from "./pipeline.ts";
export { JsonJobRepository, type JsonJobRepositoryOptions } from "./json-repository.ts";
export { FsWorkspaceGateway, computeStorageView } from "./storage.ts";
export { SpeedHintTracker, type HintThresholds } from "./speed-hints.ts";
export { resolveConfig, DEFAULT_CONFIG, type JobEngineConfig } from "./config.ts";
export { newJobId, newSessionEpoch, normalizeIdempotencyKey } from "./ids.ts";
export {
  InsufficientSpaceError,
  InvalidTransitionError,
  JobEngineError,
  JobNotFoundError,
} from "./errors.ts";
export { VIKING_RELAY_TAG } from "./gateways.ts";
export type {
  AddTorrentOptions,
  JobRepository,
  PackagingGateway,
  PreflightRequest,
  PreflightVerdict,
  StorageGateway,
  TorrentGateway,
  TorrentHandle,
  UploadRequest,
  VikingGateway,
  VikingUploadResult,
  WorkspaceGateway,
  ZipRequest,
} from "./gateways.ts";
export type {
  DownloadTelemetry,
  FailureKind,
  IntakeSource,
  JobError,
  JobRecord,
  JobResult,
  JobState,
  SpeedHint,
  StageMap,
  StageName,
  StageState,
  StorageView,
  TorrentFileEntry,
  TorrentMetadataInfo,
} from "./types.ts";
export {
  JOB_STATES,
  STAGE_NAMES,
  STAGE_STATES,
  TERMINAL_JOB_STATES,
  initialStageMap,
  isTerminalJobState,
} from "./types.ts";
