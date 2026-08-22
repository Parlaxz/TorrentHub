/**
 * Viking (vikingfile.com) fast multipart upload engine — main-process only.
 *
 * Official API reference: https://vikingfile.com/api
 * Do not import from the renderer; the configured user hash must stay
 * inside the main process.
 */
export { VikingClient, DEFAULT_CONCURRENCY, computeParts } from './viking-client'
export { VikingError, isVikingError } from './errors'
export type { VikingErrorKind, VikingErrorDetails } from './errors'
export type {
  UploadSourceFile,
  UploadProgress,
  UploadFileOptions,
  VikingClientOptions,
  VikingMultipartSession,
  CompletedPart,
  CompleteUploadInfo,
  VikingUploadResult,
  VikingFileCheck,
  VikingLogger,
  VikingBackoffOptions,
} from './types'
