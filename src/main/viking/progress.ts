import type { UploadProgress } from './types'

/**
 * Rolling upload-speed tracker over a sliding time window.
 * Samples (timestamp, cumulativeBytes) are kept for `windowMs`;
 * speed = delta bytes / delta seconds across the window.
 */
export class RollingSpeedTracker {
  private readonly samples: Array<{ t: number; bytes: number }> = []
  private lastSpeed = 0

  constructor(
    private readonly windowMs: number = 5_000,
    private readonly minSampleIntervalMs: number = 100,
  ) {}

  sample(cumulativeBytes: number, now: number = Date.now()): void {
    const last = this.samples[this.samples.length - 1]
    if (last && now - last.t < this.minSampleIntervalMs) {
      last.bytes = cumulativeBytes
      return
    }
    this.samples.push({ t: now, bytes: cumulativeBytes })
    while (this.samples.length > 1 && now - this.samples[0].t > this.windowMs) {
      this.samples.shift()
    }
    const first = this.samples[0]
    const dt = (now - first.t) / 1000
    if (dt > 0.05) this.lastSpeed = Math.max(0, (cumulativeBytes - first.bytes) / dt)
  }

  /** Bytes per second over the recent window; 0 until enough samples exist. */
  speed(): number {
    return this.lastSpeed
  }
}

export function computeEtaSeconds(remainingBytes: number, bytesPerSecond: number): number | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
  if (remainingBytes <= 0) return 0
  return remainingBytes / bytesPerSecond
}

export function buildProgress(params: {
  uploadedBytes: number
  totalBytes: number
  completedParts: number
  totalParts: number
  tracker: RollingSpeedTracker
}): UploadProgress {
  const speed = params.tracker.speed()
  const progress =
    params.totalBytes > 0 ? Math.min(1, Math.max(0, params.uploadedBytes / params.totalBytes)) : 1
  return {
    uploadedBytes: params.uploadedBytes,
    totalBytes: params.totalBytes,
    progress,
    bytesPerSecond: speed,
    etaSeconds: computeEtaSeconds(params.totalBytes - params.uploadedBytes, speed),
    completedParts: params.completedParts,
    totalParts: params.totalParts,
  }
}
