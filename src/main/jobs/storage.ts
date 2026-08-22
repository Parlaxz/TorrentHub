/**
 * Storage math + default filesystem workspace implementation.
 * Headroom math is deliberately coarse: no false precision.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { StorageView } from "./types.ts";
import type { WorkspaceGateway } from "./gateways.ts";

export interface ComputeStorageInput {
  freeBytes: number | null;
  remainingDownloadBytes: number | null;
  zipReservationBytes: number;
  safetyReserveBytes: number;
  lowHeadroomBytes: number;
}

/**
 * projectedHeadroom = free - remainingDownload - zipReservation - safetyReserve
 * warning:
 *   critical => headroom < 0 (exhaustion imminent; caller must stop safely)
 *   low      => headroom < lowHeadroomBytes
 */
export function computeStorageView(input: ComputeStorageInput): StorageView {
  const { freeBytes, remainingDownloadBytes, zipReservationBytes, safetyReserveBytes } = input;
  const projected =
    freeBytes !== null && remainingDownloadBytes !== null
      ? freeBytes - remainingDownloadBytes - zipReservationBytes - safetyReserveBytes
      : null;
  let warning: StorageView["warning"] = "none";
  if (projected !== null) {
    if (projected < 0) warning = "critical";
    else if (projected < input.lowHeadroomBytes) warning = "low";
  }
  return {
    freeBytes,
    remainingDownloadBytes,
    zipReservationBytes: zipReservationBytes || null,
    safetyReserveBytes,
    projectedHeadroomBytes: projected,
    warning,
  };
}

/** Default WorkspaceGateway backed by node:fs. Tests inject fakes instead. */
export class FsWorkspaceGateway implements WorkspaceGateway {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async createJobDirs(jobId: string): Promise<{
    jobDir: string;
    downloadDir: string;
    packageDir: string;
  }> {
    const jobDir = path.join(this.#root, "jobs", jobId);
    const downloadDir = path.join(jobDir, "download");
    const packageDir = path.join(jobDir, "package");
    await mkdir(downloadDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    return { jobDir, downloadDir, packageDir };
  }

  async removePath(target: string): Promise<void> {
    await rm(target, { recursive: true, force: true });
  }

  async joinDownload(downloadDir: string, filename: string): Promise<string> {
    await mkdir(downloadDir, { recursive: true });
    return path.join(downloadDir, filename);
  }

  async statFile(target: string): Promise<{ sizeBytes: number }> {
    const info = await stat(target);
    return { sizeBytes: info.size };
  }

  join(...parts: string[]): string {
    return path.join(...parts);
  }

  async pathExists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}
