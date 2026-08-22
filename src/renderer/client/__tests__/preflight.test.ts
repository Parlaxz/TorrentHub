import { describe, expect, it } from "vitest";
import { startBlocked, storageVerdict, zipNotice } from "../lib/preflight";
import type { StoragePreflight } from "../types";

const GB = 1024 ** 3;

function pf(over: Partial<StoragePreflight> = {}): StoragePreflight {
  return {
    selectedFiles: 2,
    selectedBytes: 91.7 * GB,
    tempZipBytes: 91.7 * GB,
    safetyReserveBytes: 5 * GB,
    peakRequiredBytes: 188.4 * GB,
    serverFreeBytes: 318.4 * GB,
    enough: true,
    blocked: false,
    ...over,
  };
}

describe("zipNotice", () => {
  it("returns null for a single selected file (direct upload)", () => {
    expect(zipNotice(1, "My Torrent", { selectedBytes: 10, tempZipBytes: null })).toBeNull();
    expect(zipNotice(0, "My Torrent", {})).toBeNull();
  });

  it("requires a ZIP for two or more files", () => {
    const n = zipNotice(2, "My Torrent", { selectedBytes: 30, tempZipBytes: 31 });
    expect(n).not.toBeNull();
    expect(n!.zipName).toBe("My Torrent.zip");
    expect(n!.fileCount).toBe(2);
    expect(n!.tempZipBytes).toBe(31);
  });

  it("falls back to local selection bytes before the server preflight arrives", () => {
    const n = zipNotice(3, "T", { selectedBytes: 50 });
    expect(n!.tempZipBytes).toBe(50);
  });
});

describe("startBlocked — Start is gated exclusively by the server verdict", () => {
  it("blocks without a preflight", () => {
    expect(startBlocked(null)).toBe(true);
  });

  it("blocks when the server says blocked", () => {
    expect(startBlocked(pf({ blocked: true, enough: true }))).toBe(true);
  });

  it("blocks when storage is insufficient", () => {
    expect(startBlocked(pf({ enough: false }))).toBe(true);
  });

  it("allows a healthy preflight", () => {
    expect(startBlocked(pf())).toBe(false);
  });
});

describe("storageVerdict", () => {
  it("affirms sufficient storage", () => {
    const v = storageVerdict(pf());
    expect(v.ok).toBe(true);
    expect(v.text).toBe("Enough storage");
  });

  it("reports how much more is needed", () => {
    const v = storageVerdict(pf({ enough: false, missingBytes: 5.0 * GB }));
    expect(v.ok).toBe(false);
    expect(v.text).toContain("NOT ENOUGH SERVER STORAGE");
    expect(v.text).toContain("5 GB more");
  });

  it("derives missing bytes when the server omits them", () => {
    const v = storageVerdict(
      pf({ enough: false, missingBytes: null, peakRequiredBytes: 200 * GB, serverFreeBytes: 190 * GB }),
    );
    expect(v.text).toContain("10 GB more");
  });
});
