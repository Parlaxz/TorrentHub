# A4 — Packaging and Storage Safety

Status: complete. Crash recovery intentionally out of scope (per spec).

## Files

```
src/main/storage/
  types.ts          VolumeSpaceInfo, SpaceRequirement(Input), PreflightEvaluation,
                    LiveHeadroomInput/Result, PackagingStartInput/Evaluation, StorageStatus
  errors.ts         StorageError, StorageUnavailableError, InsufficientDiskSpaceError
  spacePolicy.ts    pure math: estimates, reserve, peak, headroom, status classification
  volumeSpace.ts    getVolumeSpace(path) via fs.promises.statfs
  preflight.ts      checkPreflight / assertPreflightAllowsStart (fresh statfs + policy)
  liveMonitor.ts    sampleLiveHeadroom + createLiveStoragePoller (~1s UI updates)
  index.ts          barrel

src/main/package/
  types.ts          SelectedFileEntry, PackagingRequest/Progress/Outcome, isZipRequired()
  errors.ts         typed packaging errors (see below)
  archivePath.ts    archive-relative path validation, normalization, collision resolution
  zipWriter.ts      streaming STORE ZIP writer (archiver v8 ZipArchive)
  packager.ts       packageSelectedFiles() orchestrator
  index.ts          barrel

tests/
  helpers/zipInspect.ts        dependency-free ZIP central-directory parser + CRC32
  package/archivePath.test.ts
  package/packager.test.ts
  storage/spacePolicy.test.ts
  storage/storage.test.ts

reports/A4_PACKAGING_STORAGE.md   this file
```

## Public interface

### Packaging (`src/main/package`)

```ts
packageSelectedFiles(request: PackagingRequest): Promise<PackagingOutcome>

interface PackagingRequest {
  outputDirectory: string;      // where <name>.partial.zip / <name>.zip are written
  baseName: string;             // sanitized into a safe file stem
  files: SelectedFileEntry[];   // EXPLICIT canonical selection only
  forceZip?: boolean;           // "always ZIP" support for the caller
  validateSizes?: boolean;      // default true: lstat size must equal declared size
  signal?: AbortSignal;
  onProgress?: (p: PackagingProgress) => void;
  storageProbe?: (volumePath) => Promise<{freeBytes}>; // DI hook, defaults to real statfs
}

interface SelectedFileEntry {
  absoluteSourcePath: string;
  archiveRelativePath: string;  // desired path inside archive ("sub/dir/file.mkv")
  sizeBytes: number;
  torrentFileIndex?: number;
}

type PackagingOutcome =
  | { kind: 'single-file'; sourcePath: string; sizeBytes: number }   // upload original directly
  | { kind: 'archive'; archivePath: string; archiveSizeBytes: number; fileCount: number };

isZipRequired(fileCount: number, forceZip = false): boolean     // count > 1 || forceZip
validateArchiveRelativePath(p): string                          // throws UnsafeArchivePathError
resolveArchivePathCollisions(paths: string[]): string[]         // deterministic " (n)" suffixes
sanitizeBaseName(name: string): string
```

Selective-file rule: only entries from `files` enter the archive. The packager never
walks directories; deselected zero-byte files, piece-boundary artifacts and unrelated
files cannot be packaged because they are never referenced.

Flow: validate paths -> lstat every source (must be a regular file; symlinks/reparse
points rejected, not followed) -> size validation -> ZIP decision ->
FRESH disk check at packaging start -> stream to `<name>.partial.zip` ->
best-effort fsync -> atomic rename to `<name>.zip`. On any failure/cancel: streams
destroyed, `.partial.zip` deleted (retrying briefly against Windows EBUSY), sources
untouched.

### Storage (`src/main/storage`)

```ts
getVolumeSpace(path): Promise<VolumeSpaceInfo>            // {path, totalBytes, freeBytes}
checkPreflight(volumePath, input): Promise<PreflightEvaluation>
assertPreflightAllowsStart(volumePath, input): Promise<PreflightEvaluation>  // throws when blocked
computeLiveHeadroom(input): LiveHeadroomResult            // stateless, pure
sampleLiveHeadroom(volumePath, input): Promise<LiveHeadroomResult>  // fresh statfs each call
createLiveStoragePoller(volumePath, input, intervalMs=1000) // {sample, start(onSample,onError), stop}
evaluatePackagingStart(input): PackagingStartEvaluation   // pure
estimateZipBytes(selectedBytes, fileCount): number
computeSafetyReserve(selectedBytes): number
computeSpaceRequirement(input): SpaceRequirement
classifyStatus(headroomBytes, requiredBytes): 'ok'|'warning'|'blocked'
```

## ZIP choices

- Library: **archiver v8** (`new ZipArchive({ store: true })`). Note: archiver 8 is
  native ESM with class exports; the old `archiver('zip', ...)` factory API no longer
  exists. `@types/archiver@8` matches.
- **STORE mode** (no recompression): torrent payloads are MKV/MP4/RAR/7z/JPEG/ISO;
  we want a container, not CPU burn.
- **ZIP64**: handled automatically by archiver/zip-stream when entry sizes or offsets
  exceed classic limits. Not exercised in tests (would need >4 GiB fixtures).
- **Streaming**: one `fs.ReadStream` per selected file piped through a counting
  Transform into the archiver; nothing is buffered whole in memory.
- Progress counts raw source bytes (1:1 with archive payload in STORE mode), so
  percentage reflects actual bytes, never file counts. Throughput = processed/elapsed.
- Output written as `<name>.partial.zip`, then atomically renamed to `<name>.zip`
  after successful finalization + close (+ best-effort fsync). A stale final archive
  is removed before rename (documented overwrite-on-repackage behavior).

## Disk-space formulas

Constants: `GIB = 1024^3`.

- `selectedBytes` = sum of declared selected file sizes.
- `zipRequired` = `fileCount > 1 || forceZip`.
- `estimatedZipBytes = ceil(selectedBytes) + fileCount * 512 + 64 KiB`
  (bounded per-entry header/central-dir/data-descriptor allowance + global EOCD/ZIP64
  slack). Conservative but not a multiplier: overhead for a 100 GiB selection is < 0.1%.
- `safetyReserveBytes = max(2 GiB, ceil(5% * selectedBytes))`.
- Pre-download peak:
  - no ZIP: `requiredPeakBytes = selectedBytes + reserve`
  - ZIP:    `requiredPeakBytes = selectedBytes + estimatedZipBytes + reserve`
  (during packaging both the downloaded files and the growing archive exist.)
- `projectedHeadroomBytes = freeBytes - requiredPeakBytes`.

Status policy (headroom-based, not percent-free):

- `blocked`: `projectedHeadroomBytes < 0` — app must not allow Start.
- `warning`: `0 <= headroom < max(1 GiB, 10% of requiredBytes)` — tight, may fail.
- `ok`: otherwise.

### Live during download

Inputs: current free disk, selected total, downloaded selected bytes, zipRequired.

```
remainingDownloadBytes = max(0, selectedTotal - downloadedSelected)
neededForZipBytes      = zipRequired ? estimatedZipBytes : 0
safetyReserveBytes     = max(2 GiB, 5% of selectedTotal)
requiredFutureBytes    = remainingDownloadBytes + neededForZipBytes + safetyReserveBytes
projectedHeadroomBytes = currentFreeBytes - requiredFutureBytes
status                 = classifyStatus(...)
```

UI rows map directly: Free / Needed to finish download / Needed for ZIP /
Safety reserve / Projected headroom.

### Fresh pre-packaging check

At the moment packaging is about to begin (sources already fully on disk), a FRESH
`statfs` is taken; the pre-download preflight is never trusted:

```
requiredAdditionalBytes = estimatedZipBytes + safetyReserveBytes
allowed = currentFreeBytes >= requiredAdditionalBytes
deficitBytes = max(0, requiredAdditionalBytes - currentFreeBytes)
```

If not allowed, `packageSelectedFiles` throws
`InsufficientDiskSpaceError(phase='packaging-start')` carrying
`{ freeBytes, requiredBytes, deficitBytes }` before creating any artifact — the
higher layer can show "Free X more GB, then Retry Storage Check" and retry safely;
downloaded torrent files remain untouched.

## Typed errors

| Error | code | thrown when |
|---|---|---|
| InsufficientDiskSpaceError | INSUFFICIENT_DISK_SPACE | preflight/live/packaging-start space check fails |
| SelectedSourceMissingError | SELECTED_SOURCE_MISSING | source lstat fails |
| SourceNotRegularFileError | SOURCE_NOT_REGULAR_FILE | symlink/reparse point or non-file source |
| SourceSizeMismatchError | SOURCE_SIZE_MISMATCH | lstat size != declared size (default validated) |
| UnsafeArchivePathError | UNSAFE_ARCHIVE_PATH | traversal, absolute, drive prefix, UNC, reserved name, control chars, bad segment |
| ZipStreamError | ZIP_STREAM_FAILURE / ZIP_FINALIZE_FAILURE | stream or finalization failure |
| RenameFailedError | RENAME_FAILED | partial->final rename failed (partial cleaned up) |
| PackagingCancelledError | PACKAGING_CANCELLED | AbortSignal fired |
| InvalidPackagingRequestError | INVALID_PACKAGING_REQUEST | empty selection, unusable baseName |
| StorageUnavailableError | STORAGE_UNAVAILABLE | statfs failed |

## Path safety rules

- Backslashes normalized to `/`; duplicate slashes collapsed.
- Rejected: leading `/`, drive prefixes (`C:`), UNC, any `..` or `.` segment, empty
  trailing segments, NUL/control characters, segments ending in dot/space, Windows
  reserved device stems (CON, PRN, AUX, NUL, COM0-9, LPT0-9, case-insensitive).
- Logical torrent subdirectories preserved as-is inside the archive.
- Collisions resolved deterministically in input order: later duplicates become
  `stem (2).ext`, `stem (3).ext`... (case-insensitive detection, original casing kept).
- Sources must be regular files; symlinks/reparse points are rejected rather than
  followed, so an archive entry can never escape the job directory through a link.

## Tests / results

Runner: `node --test "tests/package/*.test.ts" "tests/storage/*.test.ts"` (Node 25,
native TS type stripping).

```
tests 78 | suites 16 | pass 77 | fail 0 | skipped 1 | duration ~2s
tsc --strict --noEmit: clean
```

Covered:
- one file => no ZIP (single-file outcome, output dir untouched); forceZip => ZIP
- 2+ files => single ZIP; nested archive paths preserved
- explicit selected list only: stray deselected file and zero-byte deselected file
  NOT packaged and left untouched
- STORE verified by parsing the produced ZIP's central directory (method 0) and
  byte-comparing contents + CRC32 (dependency-free test helper)
- traversal/absolute/drive/UNC/reserved-name/control-char archive paths rejected
  before any writes; deterministic collision suffixes
- partial -> final rename leaves no `.partial.zip`; repackage overwrites stale final
- progress reaches exact byte total, progress=1, monotonic, throughput > 0,
  filesCompleted == filesTotal
- insufficient-disk math (pure), preflight blocked path (astronomical selection vs
  real statfs, no mocks), live headroom incl. spec-example shape, packaging-start
  block via injected probe with exact deficit, no artifacts created
- missing source, size mismatch, symlink rejection (skipped where the OS forbids
  symlink creation), mid-stream cancellation deletes partials and spares sources

## Integration notes

- **Dependency**: add `archiver@^8` (and dev `@types/archiver@^8`) to package.json.
  archiver 8 is ESM-only with class exports; do NOT use the legacy factory API.
- **Module system**: sources are TypeScript with erasable-only syntax and explicit
  `.ts` relative import extensions so Node >= 22.6 runs them natively (verified on
  Node 25). If the root tsconfig emits, enable `allowImportingTsExtensions` +
  `noEmit` (bundler-style) or adjust extensions; `module: nodenext` +
  `moduleResolution: nodenext` verified clean with `--strict`.
- **Internal types**: all contracts currently live in `src/main/*/types.ts` because
  shared contracts were unavailable. When `src/shared` lands, move
  `SelectedFileEntry`, `PackagingOutcome`, `VolumeSpaceInfo`, status unions and error
  codes there and re-export for compatibility.
- **Windows**: `fs.statfs` used for volume stats; partial deletion retries briefly
  against EBUSY while streams settle. Symlink test auto-skips without symlink
  privilege.
- **Job engine wiring**: poll via `createLiveStoragePoller(...)` at ~1000 ms and stop
  it on job end; always gate Start on `assertPreflightAllowsStart` and packaging on
  the built-in fresh check (automatic inside `packageSelectedFiles`).
