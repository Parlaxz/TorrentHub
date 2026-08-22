import { useEffect, useMemo, useRef, useState } from "react";
import {
  annotateSelection,
  buildTree,
  flattenVisible,
  selectionStats,
  toggleNode,
  type CheckedNode,
  type TreeFile,
} from "../lib/treeModel";
import { formatBytes } from "../lib/format";
import { Button, TextInput } from "./ui";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

function TriCheckbox({
  state,
  onChange,
  label,
}: {
  state: "checked" | "unchecked" | "indeterminate";
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "checked"}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-600"
    />
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" aria-hidden="true">
      <path
        d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1V4z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true">
      <path
        d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * Hierarchical selection tree over torrent files.
 *
 * Scale strategy: the tree is flattened into visible rows and rendered through
 * a tiny built-in windower (fixed row height, absolute positioning) — no
 * dependency, no 20k heavy DOM rows. Search filters visibility only; folder
 * checks always apply to every descendant, including hidden matches.
 */
export function FileTree({
  files,
  selected,
  onSelectionChange,
  height = 420,
}: {
  files: readonly TreeFile[];
  selected: ReadonlySet<number>;
  onSelectionChange: (next: Set<number>) => void;
  /** Viewport height in px. */
  height?: number;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);

  const rawTree = useMemo(() => buildTree(files), [files]);
  const annotated = useMemo(() => annotateSelection(rawTree, selected), [rawTree, selected]);
  const rows = useMemo(() => flattenVisible(annotated, expanded, query), [annotated, expanded, query]);

  // Default-expand top-level folders once.
  useEffect(() => {
    setExpanded(new Set(rawTree.children.filter((c) => c.isFolder).map((c) => c.path)));
  }, [rawTree]);

  const stats = useMemo(() => selectionStats(files, selected), [files, selected]);

  const toggle = (node: CheckedNode): void => {
    onSelectionChange(toggleNode(node, selected));
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const windowed = rows.slice(start, end);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <TextInput
          type="search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter files"
          className="max-w-xs flex-1"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onSelectionChange(new Set(files.map((f) => f.index)))}>
            Select All
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onSelectionChange(new Set())}>
            Select None
          </Button>
        </div>
      </div>

      <div className="mb-1.5 flex items-baseline justify-between text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        <span aria-live="polite">
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{stats.count}</span> of {files.length} files ·{" "}
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{formatBytes(stats.bytes)}</span> of{" "}
          {formatBytes(rawTree.sizeBytes)}
        </span>
        {query.trim() !== "" && <span>{rows.length} shown</span>}
      </div>

      <div
        role="tree"
        aria-label="Torrent files"
        tabIndex={0}
        className="overflow-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        style={{ height }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {windowed.map((row, i) => {
            const abs = start + i;
            const n = row.node;
            const open = query.trim() !== "" || expanded.has(n.path);
            return (
              <div
                key={n.path}
                role="treeitem"
                aria-selected={n.checkState === "checked"}
                aria-expanded={n.isFolder ? open : undefined}
                aria-level={row.depth + 1}
                className={`absolute inset-x-0 flex items-center gap-2 px-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                  abs % 2 === 1 ? "bg-zinc-50/60 dark:bg-zinc-900/40" : ""
                }`}
                style={{ top: abs * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 8 + row.depth * 16 }}
                onClick={() => toggle(n)}
              >
                {n.isFolder ? (
                  <button
                    type="button"
                    aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
                    className="shrink-0 rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(n.path)) next.delete(n.path);
                        else next.add(n.path);
                        return next;
                      });
                    }}
                  >
                    <Chevron open={open} />
                  </button>
                ) : (
                  <span className="w-[19px] shrink-0" />
                )}
                <TriCheckbox state={n.checkState} onChange={() => toggle(n)} label={n.name} />
                {n.isFolder ? <FolderIcon /> : <FileIcon />}
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800 dark:text-zinc-200" title={n.path}>
                  {n.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-500">
                  {formatBytes(n.sizeBytes)}
                </span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <p className="p-4 text-center text-xs text-zinc-500 dark:text-zinc-500">No files match “{query}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}
