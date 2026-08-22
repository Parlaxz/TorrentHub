import { describe, expect, it } from "vitest";
import { formatBytes, formatCount, formatEta, formatPercent, formatSpeed } from "../lib/format";

describe("formatBytes", () => {
  it("renders human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(91.7 * 1024 ** 3)).toBe("91.7 GB");
    expect(formatBytes(221.4 * 1024 ** 3)).toBe("221.4 GB");
  });

  it("handles missing and negative values", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1024)).toBe("-1 KB");
  });
});

describe("formatSpeed", () => {
  it("always appends per-second", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(823 * 1024)).toBe("823 KB/s");
    expect(formatSpeed(47.3 * 1024 ** 2)).toBe("47.3 MB/s");
    expect(formatSpeed(null)).toBe("—");
  });
});

describe("formatEta", () => {
  it("formats compact durations", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(368)).toBe("6m 08s");
    expect(formatEta(7325)).toBe("2h 02m");
  });

  it("returns an em dash when ETA is not meaningful", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(-5)).toBe("—");
  });
});

describe("formatPercent / formatCount", () => {
  it("clamps and floors percent", () => {
    expect(formatPercent(81.4)).toBe("81%");
    expect(formatPercent(120)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
  });
  it("localizes counts", () => {
    expect(formatCount(20000)).toBe("20,000");
  });
});
