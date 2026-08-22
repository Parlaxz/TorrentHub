import { describe, expect, it } from "vitest";
import {
  clampPercent,
  formatBytes,
  formatCountdown,
  formatEta,
  formatSpeed,
  formatTimestamp,
} from "../../../src/renderer/server/domain/format";

describe("formatBytes", () => {
  it("formats terabytes with one decimal", () => {
    expect(formatBytes(1.42 * 1024 ** 4)).toBe("1.4 TB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(221 * 1024 ** 3)).toBe("221 GB");
    expect(formatBytes(38.7 * 1024 ** 2)).toBe("38.7 MB");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders null/undefined/non-finite as em dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatSpeed", () => {
  it("appends /s", () => {
    expect(formatSpeed(38.7 * 1024 ** 2)).toMatch(/MB\/s$/);
    expect(formatSpeed(null)).toBe("—");
  });
});

describe("formatCountdown", () => {
  it("renders mm:ss", () => {
    expect(formatCountdown(9 * 60_000 + 42_000)).toBe("09:42");
    expect(formatCountdown(7_000)).toBe("00:07");
  });

  it("clamps expired to 00:00", () => {
    expect(formatCountdown(-5)).toBe("00:00");
  });
});

describe("formatEta", () => {
  it("humanizes seconds/minutes/hours", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(125)).toBe("2m 5s");
    expect(formatEta(3600 + 120)).toBe("1h 2m");
    expect(formatEta(null)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("falls back to raw string for invalid dates", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("clampPercent", () => {
  it("clamps into [0,100]", () => {
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});
