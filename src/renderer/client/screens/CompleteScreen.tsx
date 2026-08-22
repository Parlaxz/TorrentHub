import { useState } from "react";
import { Button, Panel } from "../components/ui";
import type { VikingBridge } from "../lib/bridge";
import { formatBytes } from "../lib/format";

/** Screen 8 — complete. Clipboard only via the preload bridge; fallback = select text. */
export function CompleteScreen({
  bridge,
  filename,
  sizeBytes,
  url,
  directUrl,
  onNewTorrent,
}: {
  bridge: VikingBridge | null;
  filename: string;
  sizeBytes: number | null;
  url: string;
  /** Direct download link resolved by the server, when available. */
  directUrl?: string | null;
  onNewTorrent: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, tag: string): Promise<void> => {
    if (bridge) {
      try {
        if (await bridge.copyText(text)) {
          setCopied(tag);
          window.setTimeout(() => setCopied(null), 2000);
          return;
        }
      } catch {
        /* fall through */
      }
    }
    // Renderer-side fallback (works when the page has clipboard permission).
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied(null), 2000);
      return;
    } catch {
      /* fall through */
    }
    // Last resort: let the user select the readonly input manually.
    window.getSelection()?.selectAllChildren(document.body);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-10">
      <Panel className="text-center">
        <span
          aria-hidden="true"
          className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-lg font-bold text-white"
        >
          ✓
        </span>
        <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100">Complete</h1>
        <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-300" title={filename}>
          {filename}
        </p>
        {sizeBytes != null ? (
          <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatBytes(sizeBytes)}</p>
        ) : null}

        <div className="mt-5 text-left">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Viking URL
          </p>
          <input
            readOnly
            value={url}
            aria-label="Viking URL"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full cursor-text rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-[12px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          />
        </div>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button onClick={() => void copy(url, "page")}>
            {copied === "page" ? "Copied ✓" : "Copy Link"}
          </Button>
          {directUrl ? (
            <Button variant="secondary" onClick={() => void copy(directUrl, "direct")}>
              {copied === "direct" ? "Copied ✓" : "Copy Direct Link"}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onNewTorrent}>
            New Torrent
          </Button>
        </div>
      </Panel>
    </div>
  );
}
