/**
 * Presentation-only speed hints derived from telemetry.
 * Hints NEVER fail or cancel a torrent; they only inform the UI.
 */
import type { DownloadTelemetry, SpeedHint } from "./types.ts";

export interface HintThresholds {
  zeroSpeedMs: number;
  slowSpeedBps: number;
  slowSpeedMs: number;
}

export class SpeedHintTracker {
  #thresholds: HintThresholds;
  #zeroSince: number | null = null;
  #slowSince: number | null = null;

  constructor(thresholds: HintThresholds) {
    this.#thresholds = thresholds;
  }

  reset(): void {
    this.#zeroSince = null;
    this.#slowSince = null;
  }

  /** Feed one telemetry sample; returns the current presentation hint. */
  observe(telemetry: DownloadTelemetry, now: number): SpeedHint {
    const speed = Number.isFinite(telemetry.speedBps) ? Math.max(0, telemetry.speedBps) : 0;

    if (speed === 0) {
      this.#zeroSince ??= now;
    } else {
      this.#zeroSince = null;
    }

    if (speed > 0 && speed < this.#thresholds.slowSpeedBps) {
      this.#slowSince ??= now;
    } else {
      this.#slowSince = null;
    }

    if (
      this.#zeroSince !== null &&
      now - this.#zeroSince >= this.#thresholds.zeroSpeedMs
    ) {
      return "waiting_for_peers";
    }
    if (
      this.#slowSince !== null &&
      now - this.#slowSince >= this.#thresholds.slowSpeedMs
    ) {
      return "slow";
    }
    return null;
  }
}
