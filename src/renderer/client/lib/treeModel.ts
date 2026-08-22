/**
 * Torrent file-tree model. Pure logic, no React — fully unit-testable.
 *
 * Semantics required by A7:
 *  - hierarchical folders built from forward-slash paths
 *  - tri-state checkboxes (checked / indeterminate / unchecked)
 *  - toggling a folder toggles ALL descendant files, including ones hidden by
 *    an active search filter (search affects visibility only)
 *  - flattened visible-row list for lightweight windowed rendering
 */

export interface TreeFile {
  index: number;
  path: string;
  sizeBytes: number;
}

export type CheckState = "checked" | "unchecked" | "indeterminate";

export interface TreeNode {
  /** Full path from torrent root; "" for the synthetic root. */
  path: string;
  name: string;
  isFolder: boolean;
  /** File size for files; sum of descendant file sizes for folders. */
  sizeBytes: number;
  /** 1 for a file; descendant file count for folders. */
  fileCount: number;
  children: TreeNode[];
  /** qBittorrent file index (files only). */
  index?: number;
  depth: number;
}

/** Annotated node: tri-state computed against the selected-index set. */
export interface CheckedNode extends TreeNode {
  checkState: CheckState;
  children: CheckedNode[];
}

export interface FlatRow {
  node: CheckedNode;
  depth: number;
}

/** Build a synthetic-root tree from flat file entries. */
export function buildTree(files: readonly TreeFile[]): TreeNode {
  const root: TreeNode = {
    path: "",
    name: "",
    isFolder: true,
    sizeBytes: 0,
    fileCount: 0,
    children: [],
    depth: -1,
  };

  const folderIndex = new Map<string, TreeNode>([["", root]]);

  const ensureFolder = (path: string): TreeNode => {
    const existing = folderIndex.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const parentPath = cut === -1 ? "" : path.slice(0, cut);
    const name = cut === -1 ? path : path.slice(cut + 1);
    const parent = ensureFolder(parentPath);
    const node: TreeNode = {
      path,
      name,
      isFolder: true,
      sizeBytes: 0,
      fileCount: 0,
      children: [],
      depth: parent.depth + 1,
    };
    parent.children.push(node);
    folderIndex.set(path, node);
    return node;
  };

  for (const f of files) {
    const normalized = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const cut = normalized.lastIndexOf("/");
    const parentPath = cut === -1 ? "" : normalized.slice(0, cut);
    const name = cut === -1 ? normalized : normalized.slice(cut + 1);
    const parent = ensureFolder(parentPath);
    parent.children.push({
      path: normalized,
      name,
      isFolder: false,
      sizeBytes: f.sizeBytes,
      fileCount: 1,
      children: [],
      index: f.index,
      depth: parent.depth + 1,
    });
  }

  sortTree(root);
  recomputeAggregates(root);
  return root;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  for (const c of node.children) sortTree(c);
}

function recomputeAggregates(node: TreeNode): void {
  if (!node.isFolder) return;
  let size = 0;
  let count = 0;
  for (const c of node.children) {
    recomputeAggregates(c);
    size += c.sizeBytes;
    count += c.fileCount;
  }
  node.sizeBytes = size;
  node.fileCount = count;
}

/** All descendant file indexes of a node (inclusive of the node itself). */
export function descendantIndexes(node: TreeNode): number[] {
  const out: number[] = [];
  const walk = (n: TreeNode): void => {
    if (n.isFolder) n.children.forEach(walk);
    else if (n.index != null) out.push(n.index);
  };
  walk(node);
  return out;
}

/**
 * Compute tri-state for every node in one post-order pass.
 * Returns a new annotated tree; original nodes are not mutated.
 */
export function annotateSelection(
  root: TreeNode,
  selected: ReadonlySet<number>,
): CheckedNode {
  const walk = (node: TreeNode): CheckedNode => {
    if (!node.isFolder) {
      return { ...node, children: [], checkState: selected.has(node.index!) ? "checked" : "unchecked" };
    }
    const children = node.children.map(walk);
    const checked = children.filter((c) => c.checkState === "checked").length;
    const state: CheckState =
      checked === 0 ? "unchecked" : checked === children.length ? "checked" : "indeterminate";
    return { ...node, children, checkState: state };
  };
  return walk(root);
}

/**
 * Flatten an annotated tree into visible rows for windowed rendering.
 *
 * @param expanded set of folder paths currently expanded by the user
 * @param query    free-text filter matched against name/path. Visibility-only:
 *                 matching nodes plus their ancestor chains are shown and
 *                 auto-expanded; everything else is hidden. Collapsed folders
 *                 still participate in selection via toggleNode().
 */
export function flattenVisible(
  root: CheckedNode,
  expanded: ReadonlySet<string>,
  query: string,
): FlatRow[] {
  const q = query.trim().toLowerCase();
  const rows: FlatRow[] = [];

  const selfMatches = (n: TreeNode): boolean =>
    q === "" ||
    n.name.toLowerCase().includes(q) ||
    n.path.toLowerCase().includes(q);

  const subtreeMatches = (n: TreeNode): boolean => {
    if (selfMatches(n)) return true;
    return n.children.some(subtreeMatches);
  };

  const walk = (node: CheckedNode): void => {
    for (const child of node.children) {
      if (q !== "" && !subtreeMatches(child)) continue;
      rows.push({ node: child, depth: child.depth });
      if (child.isFolder && (q !== "" || expanded.has(child.path))) walk(child);
    }
  };

  walk(root);
  return rows;
}

/**
 * Toggle helper operating on the raw (unannotated) tree.
 * If every descendant index is selected, clears them; otherwise selects all.
 * Returns a NEW Set; never mutates the input.
 */
export function toggleNode(node: TreeNode, selected: ReadonlySet<number>): Set<number> {
  const next = new Set(selected);
  const indexes = descendantIndexes(node);
  const shouldSelect = !indexes.every((i) => next.has(i));
  for (const i of indexes) {
    if (shouldSelect) next.add(i);
    else next.delete(i);
  }
  return next;
}

export interface SelectionStats {
  count: number;
  bytes: number;
}

export function selectionStats(
  files: readonly TreeFile[],
  selected: ReadonlySet<number>,
): SelectionStats {
  let count = 0;
  let bytes = 0;
  for (const f of files) {
    if (selected.has(f.index)) {
      count++;
      bytes += f.sizeBytes;
    }
  }
  return { count, bytes };
}
