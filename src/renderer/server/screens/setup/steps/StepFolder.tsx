/** Setup step 1 — working folder with drive capacity visibility. */

import { useState } from "react";
import { formatBytes } from "../../../domain/format";
import { Button, TextField } from "../../../components/ui";
import type { StepProps } from "../SetupWizard";

export const FOLDER_EXPLANATION = "Temporary torrent downloads and ZIP files are stored here.";

export function StepFolder({ bridge, state, dispatch }: StepProps) {
  const [manualPath, setManualPath] = useState("");
  const folder = state.folder;

  const applyPath = async (path: string) => {
    dispatch({ type: "FOLDER_BUSY", busy: true });
    try {
      const status = await bridge.setWorkingFolderPath(path);
      dispatch({ type: "FOLDER_STATUS", status });
    } catch {
      dispatch({ type: "FOLDER_BUSY", busy: false });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{FOLDER_EXPLANATION}</p>

      {folder?.drive ? (
        <div
          className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950"
          data-testid="drive-info"
        >
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              Drive {folder.drive.root}
              {folder.drive.label ? ` — ${folder.drive.label}` : ""}
            </span>
            <span className="text-xs uppercase tracking-wide text-zinc-500">{folder.drive.kind}</span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">Total</dt>
              <dd className="font-mono text-zinc-800 dark:text-zinc-200">
                {formatBytes(folder.drive.totalBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">Free</dt>
              <dd className="font-mono font-semibold text-emerald-600 dark:text-emerald-400" data-testid="drive-free">
                {formatBytes(folder.drive.freeBytes)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      {folder?.path ? (
        <p className="rounded-md bg-blue-50 px-3 py-2 font-mono text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-200">
          {folder.path}
        </p>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No working folder selected yet. A high-capacity workspace such as{" "}
          <span className="font-mono">D:\VikingRelay</span> works well.
        </p>
      )}

      {folder && !folder.writable ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {folder.error || "That folder is not writable."}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2 pt-1">
        <TextField
          id="setup-folder-manual"
          label="Or type a folder path"
          value={manualPath}
          onChange={(event) => setManualPath(event.target.value)}
          placeholder="D:\\VikingRelay"
          className="min-w-0 flex-1"
        />
        <Button
          disabled={state.folderBusy || manualPath.trim().length === 0}
          onClick={() => void applyPath(manualPath)}
        >
          Use this folder
        </Button>
      </div>
    </div>
  );
}
