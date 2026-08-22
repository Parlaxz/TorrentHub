export interface SelectedFileEntry {
  absoluteSourcePath: string;
  archiveRelativePath: string;
  sizeBytes: number;
  torrentFileIndex?: number;
}

export interface PackagingProgress {
  processedBytes: number;
  totalBytes: number;
  progress: number;
  throughputBytesPerSecond: number;
  filesCompleted: number;
  filesTotal: number;
}

export interface PackagingRequest {
  outputDirectory: string;
  baseName: string;
  files: SelectedFileEntry[];
  forceZip?: boolean;
  validateSizes?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: PackagingProgress) => void;
  storageProbe?: (volumePath: string) => Promise<{ freeBytes: number }>;
}

export type PackagingOutcome =
  | { kind: 'single-file'; sourcePath: string; sizeBytes: number }
  | {
      kind: 'archive';
      archivePath: string;
      archiveSizeBytes: number;
      fileCount: number;
    };

export function isZipRequired(fileCount: number, forceZip = false): boolean {
  return forceZip || fileCount > 1;
}
