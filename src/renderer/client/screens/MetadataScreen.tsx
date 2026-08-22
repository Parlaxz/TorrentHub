import { Button, Panel, Spinner } from "../components/ui";

/**
 * Screen 3 — reading metadata. Indeterminate only: no fake percentage.
 * Polling of the draft happens in the parent; this is presentational.
 */
export function MetadataScreen({
  sourceKind,
  onCancel,
}: {
  sourceKind: "magnet" | "url" | null;
  onCancel?: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-10">
      <Panel className="text-center">
        <div className="mx-auto mb-4 w-full">
          <div
            role="progressbar"
            aria-label="Reading torrent"
            className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <div className="indeterminate-bar h-full w-1/3 rounded-full bg-blue-600" />
          </div>
        </div>
        <h2 className="flex items-center justify-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <Spinner className="text-blue-600" />
          Reading torrent…
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {sourceKind === "magnet"
            ? "Finding peers and retrieving the file list."
            : "Downloading and parsing the .torrent file."}
        </p>
        {onCancel ? (
          <Button variant="ghost" className="mt-5" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </Panel>
    </div>
  );
}
