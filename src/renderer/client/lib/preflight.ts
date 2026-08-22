/**
 * Selection → packaging decision + storage preflight presentation logic.
 * The renderer NEVER computes disk math; it only derives UI intent from
 * server-authoritative values.
 */

import type { StoragePreflight } from "../types";

export interface ZipNotice {
  required: true;
  fileCount: number;
  zipName: string;
  selectedBytes: number;
  tempZipBytes: number;
}

/**
 * Single file  → uploaded directly, no ZIP, no warning (null).
 * Two or more  → ZIP REQUIRED notice. Sizes come from the server preflight
 * when available; before that, the renderer's local selection stats are used
 * as a provisional figure (server values always win once present).
 */
export function zipNotice(
  selectedCount: number,
  torrentName: string,
  sizes?: { selectedBytes?: number | null; tempZipBytes?: number | null },
): ZipNotice | null {
  if (selectedCount < 2) return null;
  const selected = sizes?.selectedBytes ?? 0;
  return {
    required: true,
    fileCount: selectedCount,
    zipName: `${torrentName || "torrent"}.zip`,
    selectedBytes: selected,
    tempZipBytes: sizes?.tempZipBytes ?? selected,
  };
}

/** Start is gated exclusively by the server's verdict. */
export function startBlocked(preflight: StoragePreflight | null): boolean {
  if (!preflight) return true;
  if (preflight.blocked === true) return true;
  return !preflight.enough;
}

/** Short verdict line under the storage table. */
export function storageVerdict(
  preflight: StoragePreflight,
): { ok: boolean; text: string } {
  if (preflight.enough && preflight.blocked !== true) {
    return { ok: true, text: "Enough storage" };
  }
  const missing = preflight.missingBytes ?? Math.max(0, preflight.peakRequiredBytes - preflight.serverFreeBytes);
  return {
    ok: false,
    text: `NOT ENOUGH SERVER STORAGE — need approximately ${formatGb(missing)} more.`,
  };
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${Math.round(gb * 10) / 10} GB`;
}
