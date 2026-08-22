import { describe, expect, it } from "vitest";
import {
  classifyJobError,
  classifyJobFailure,
  classifyMessage,
  presentError,
} from "../lib/errors";
import type { JobError } from "../types";

describe("classifyJobError", () => {
  it("maps structured failure kinds", () => {
    expect(classifyJobError({ kind: "packaging", message: "" })).toBe("packaging_failed");
    expect(classifyJobError({ kind: "upload", message: "" })).toBe("upload_failed");
    expect(classifyJobError({ kind: "finalize", message: "" })).toBe("upload_failed");
  });

  it("prioritizes the insufficient-space flag", () => {
    const err: JobError = { kind: "download", message: "whatever", insufficientSpace: true };
    expect(classifyJobError(err)).toBe("insufficient_disk");
  });

  it("falls back to message heuristics for coarse metadata failures", () => {
    expect(classifyJobError({ kind: "metadata", message: "torrent already exists in qBittorrent" })).toBe(
      "duplicate_torrent",
    );
    expect(classifyJobError({ kind: "metadata", message: "unsupported qBittorrent version" })).toBe(
      "qbittorrent_unsupported",
    );
    expect(classifyJobError({ kind: "metadata", message: "cannot parse magnet" })).toBe("bad_torrent");
  });
});

describe("classifyMessage", () => {
  it("recognizes operational error text", () => {
    expect(classifyMessage("qBittorrent WebUI is not running")).toBe("qbittorrent_unavailable");
    expect(classifyMessage("duplicate unmanaged torrent")).toBe("duplicate_torrent");
    expect(classifyMessage("ENOSPC while writing")).toBe("insufficient_disk");
    expect(classifyMessage("connection refused")).toBe("server_unreachable");
    expect(classifyMessage("mystery")).toBe("unknown");
  });
});

describe("classifyJobFailure", () => {
  it("treats interrupted and cancelled states as first-class outcomes", () => {
    expect(classifyJobFailure({ state: "interrupted", error: null })).toBe("interrupted");
    expect(classifyJobFailure({ state: "cancelled", error: null })).toBe("cancelled");
  });
});

describe("presentError", () => {
  it("offers Retry Packaging only for packaging failures", () => {
    expect(presentError("packaging_failed").retry).toBe("packaging");
    expect(presentError("server_unreachable").retry).toBeUndefined();
  });

  it("offers Retry Upload for upload failures", () => {
    expect(presentError("upload_failed").retry).toBe("upload");
  });

  it("uses the fixed interrupted guidance copy", () => {
    const p = presentError("interrupted");
    expect(p.title).toContain("interrupted");
    expect(p.detail).toContain("Automatic resume is not supported");
  });
});
