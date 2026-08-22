import { describe, expect, it } from "vitest";
import {
  annotateSelection,
  buildTree,
  flattenVisible,
  selectionStats,
  toggleNode,
} from "../lib/treeModel";

const files = [
  { index: 0, path: "a.txt", sizeBytes: 10 },
  { index: 1, path: "sub/b.txt", sizeBytes: 20 },
  { index: 2, path: "sub/c.txt", sizeBytes: 30 },
  { index: 3, path: "sub/deep/d.txt", sizeBytes: 40 },
];

describe("buildTree", () => {
  it("groups files into hierarchical folders", () => {
    const root = buildTree(files);
    // Folders sort before files.
    expect(root.children.map((c) => c.name)).toEqual(["sub", "a.txt"]);
    const sub = root.children[0];
    expect(sub.isFolder).toBe(true);
    expect(sub.fileCount).toBe(3);
    expect(sub.sizeBytes).toBe(90);
    expect(sub.children.map((c) => c.name)).toEqual(["deep", "b.txt", "c.txt"]);
  });

  it("aggregates nested folder sizes", () => {
    const root = buildTree(files);
    const deep = root.children[0].children.find((c) => c.name === "deep")!;
    expect(deep.fileCount).toBe(1);
    expect(deep.sizeBytes).toBe(40);
    expect(root.sizeBytes).toBe(100);
    expect(root.fileCount).toBe(4);
  });

  it("keeps qBittorrent indexes on file nodes", () => {
    const root = buildTree(files);
    const a = root.children.find((c) => c.name === "a.txt")!;
    expect(a.index).toBe(0);
    expect(a.isFolder).toBe(false);
  });
});

describe("tri-state selection semantics", () => {
  it("marks partially-selected folders as indeterminate", () => {
    const annotated = annotateSelection(buildTree(files), new Set([1]));
    const sub = annotated.children.find((c) => c.name === "sub")!;
    expect(sub.checkState).toBe("indeterminate");
    expect(sub.children.find((c) => c.name === "b.txt")!.checkState).toBe("checked");
    expect(sub.children.find((c) => c.name === "deep")!.checkState).toBe("unchecked");
  });

  it("marks fully-selected folders as checked", () => {
    const annotated = annotateSelection(buildTree(files), new Set([0, 1, 2, 3]));
    const sub = annotated.children.find((c) => c.name === "sub")!;
    expect(sub.checkState).toBe("checked");
    expect(annotated.checkState).toBe("checked");
  });

  it("toggling a folder selects ALL descendants", () => {
    const sub = buildTree(files).children.find((c) => c.name === "sub")!;
    expect(toggleNode(sub, new Set())).toEqual(new Set([1, 2, 3]));
  });

  it("toggling a fully-selected folder deselects all descendants", () => {
    const sub = buildTree(files).children.find((c) => c.name === "sub")!;
    expect(toggleNode(sub, new Set([1, 2, 3]))).toEqual(new Set());
  });

  it("toggling does not mutate the input set", () => {
    const sub = buildTree(files).children.find((c) => c.name === "sub")!;
    const input = new Set<number>([0]);
    toggleNode(sub, input);
    expect(input).toEqual(new Set([0]));
  });
});

describe("search visibility", () => {
  it("shows matches plus their ancestor chain, auto-expanded", () => {
    const annotated = annotateSelection(buildTree(files), new Set());
    const rows = flattenVisible(annotated, new Set(), "d.txt");
    expect(rows.map((r) => r.node.path)).toEqual(["sub", "sub/deep", "sub/deep/d.txt"]);
  });

  it("search affects visibility ONLY — folder toggle still hits hidden descendants", () => {
    const raw = buildTree(files);
    const sub = raw.children.find((c) => c.name === "sub")!;
    // While searching "d.txt", c.txt is invisible, yet toggling "sub" must select it.
    const next = toggleNode(sub, new Set());
    expect(next.has(2)).toBe(true); // c.txt — hidden by the filter
    expect(next).toEqual(new Set([1, 2, 3]));
  });

  it("respects manual collapse when no query is active", () => {
    const annotated = annotateSelection(buildTree(files), new Set());
    const rows = flattenVisible(annotated, new Set(), "");
    expect(rows.map((r) => r.node.path)).toEqual(["sub", "a.txt"]);
    const open = flattenVisible(annotated, new Set(["sub", "sub/deep"]), "");
    expect(open.map((r) => r.node.path)).toContain("sub/deep/d.txt");
  });
});

describe("selectionStats", () => {
  it("counts selected files and bytes", () => {
    expect(selectionStats(files, new Set([0, 1]))).toEqual({ count: 2, bytes: 30 });
    expect(selectionStats(files, new Set())).toEqual({ count: 0, bytes: 0 });
    expect(selectionStats(files, new Set([0, 1, 2, 3]))).toEqual({ count: 4, bytes: 100 });
  });
});
