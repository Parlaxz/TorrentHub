import { ProgressBar, ProgressBlock } from "../components/ProgressBar";
import { StagePipeline } from "../components/StagePipeline";
import { StorageTable, StorageWarning, type StorageRow } from "../components/StorageTable";
import { Badge, Button, Panel, SectionTitle } from "../components/ui";
import { formatBytes, formatCount, formatEta, formatPercent, formatSpeed } from "../lib/format";
import { speedAdvisory } from "../lib/stages";
import type { JobSnapshot } from "../types";
import type { PollStatus } from "../lib/usePolling";

/**
 * Screen 5 — active job. Separate DOWNLOAD / PACKAGE / UPLOAD stages, never a
 * single fake percentage. Zero seeds / slow speeds are warnings, not failures.
 */
export function ActiveJobScreen({
  job,
  pollStatus,
  onCancel,
  onRetryPackaging,
  onRetryUpload,
}: {
  job: JobSnapshot;
  pollStatus: PollStatus;
  onCancel?: () => void;
  onRetryPackaging?: () => void;
  onRetryUpload?: () => void;
}) {
  const t = job.telemetry ?? null;
  const st = job.storage ?? null;
  const advisory = speedAdvisory(job);

  const storageRows: StorageRow[] | null = st
    ? [
        { label: "Free", bytes: st.freeBytes },
        { label: "Needed to finish", bytes: st.remainingDownloadBytes },
        { label: "Reserved for ZIP", bytes: st.zipReservationBytes },
        { label: "Safety reserve", bytes: st.safetyReserveBytes },
        { label: "Projected headroom", bytes: st.projectedHeadroomBytes, strong: true },
      ]
    : null;

  const downloadDetail =
    job.stages.download === "active" && t ? (
      <div>
        <ProgressBlock
          label="Download progress"
          pct={t.progressPct}
          done={t.downloadedBytes}
          total={t.totalSelectedBytes}
          speedBps={t.speedBps}
          etaSeconds={t.etaSeconds}
        />
        <div className="mt-2 flex gap-5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          <span>
            Seeds <span className="font-semibold text-zinc-700 dark:text-zinc-200">{t.seeds}</span>
          </span>
          <span>
            Peers <span className="font-semibold text-zinc-700 dark:text-zinc-200">{t.peers}</span>
          </span>
        </div>
      </div>
    ) : job.stages.download === "failed" ? (
      <p role="alert" className="text-[13px] text-red-700 dark:text-red-400">
        {job.error?.message || "The download failed on the server."} You can start a new torrent.
      </p>
    ) : undefined;

  const packageDetail =
    job.stages.packaging === "active" && job.packagingProgress ? (
      <div>
        <ProgressBar pct={job.packagingProgress.progressPct} tone="amber" label="Packaging progress" />
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
          <span className="font-semibold tabular-nums">{formatPercent(job.packagingProgress.progressPct)}</span>
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
            {formatCount(job.packagingProgress.processedFiles)} / {formatCount(job.packagingProgress.totalFiles)} files
          </span>
        </div>
        <div className="mt-0.5 flex gap-4 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {job.packagingProgress.throughputBps != null && (
            <span>{formatSpeed(job.packagingProgress.throughputBps)}</span>
          )}
          {job.packagingProgress.freeBytes != null && (
            <span>Free on server: {formatBytes(job.packagingProgress.freeBytes)}</span>
          )}
        </div>
      </div>
    ) : job.stages.packaging === "failed" ? (
      <div>
        <p role="alert" className="text-[13px] text-red-700 dark:text-red-400">
          {job.error?.message || "Packaging failed on the server."}
        </p>
        {onRetryPackaging ? (
          <Button variant="secondary" className="mt-2" onClick={onRetryPackaging}>
            Retry Packaging
          </Button>
        ) : null}
      </div>
    ) : job.stages.packaging === "waiting" ? (
      <p className="text-xs text-zinc-500 dark:text-zinc-500">Waiting</p>
    ) : undefined;

  const uploadDetail =
    job.stages.upload === "active" && job.uploadProgress ? (
      <div>
        <ProgressBlock
          label="Upload to Viking"
          pct={job.uploadProgress.progressPct}
          done={job.uploadProgress.uploadedBytes}
          total={job.uploadProgress.totalBytes}
          speedBps={job.uploadProgress.throughputBps}
          etaSeconds={job.uploadProgress.etaSeconds}
        />
        {job.uploadProgress.partCount != null ? (
          <p className="mt-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-500">
            Part {formatCount(job.uploadProgress.partCount)}
          </p>
        ) : null}
      </div>
    ) : job.stages.upload === "failed" ? (
      <div>
        <p role="alert" className="text-[13px] text-red-700 dark:text-red-400">
          {job.error?.message || "The upload to Viking failed."}
        </p>
        {onRetryUpload ? (
          <Button variant="secondary" className="mt-2" onClick={onRetryUpload}>
            Retry Upload
          </Button>
        ) : null}
      </div>
    ) : job.stages.upload === "waiting" ? (
      <p className="text-xs text-zinc-500 dark:text-zinc-500">Waiting</p>
    ) : undefined;

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h1 className="min-w-0 truncate text-base font-bold text-zinc-900 dark:text-zinc-100" title={job.metadata?.name}>
          {job.metadata?.name ?? "Torrent"}
        </h1>
        {pollStatus === "reconnecting" ? <Badge tone="amber">Reconnecting…</Badge> : null}
      </div>

      {pollStatus === "reconnecting" ? (
        <p role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Lost contact with the server — reconnecting. Your download continues on the server.
        </p>
      ) : null}

      {st?.warning === "low" ? (
        <div className="mb-3">
          <StorageWarning level="low">
            Server disk space is running low. The job will continue, but free space as soon as practical.
          </StorageWarning>
        </div>
      ) : null}
      {st?.warning === "critical" ? (
        <div className="mb-3">
          <StorageWarning level="critical">
            The server is about to run out of disk space. This job may be blocked or fail — free up space on the
            server now.
          </StorageWarning>
        </div>
      ) : null}

      <Panel className="mb-4">
        <SectionTitle>Stages</SectionTitle>
        <StagePipeline
          stages={[
            { key: "download", title: "DOWNLOAD", state: job.stages.download, detail: downloadDetail },
            {
              key: "package",
              title: "PACKAGE",
              state: job.stages.packaging,
              note: job.stages.packaging === "skipped" ? "Single file is uploaded directly" : undefined,
              detail: packageDetail,
            },
            { key: "upload", title: "UPLOAD TO VIKING", state: job.stages.upload, detail: uploadDetail },
          ]}
        />
      </Panel>

      {advisory ? (
        <div
          role="status"
          className={`mb-4 rounded-md border px-3 py-2.5 text-sm ${
            advisory.tone === "amber"
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              : "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
          }`}
        >
          <p className="font-bold">⚠ {advisory.title}</p>
          {t ? (
            <p className="mt-1 tabular-nums leading-snug">
              Download speed: {formatSpeed(t.speedBps)}
              {t.etaSeconds != null ? ` · ETA ${formatEta(t.etaSeconds)}` : ""}
            </p>
          ) : null}
          {advisory.lines.map((l) => (
            <p key={l} className="leading-snug opacity-90">
              {l}
            </p>
          ))}
        </div>
      ) : null}

      {storageRows ? (
        <Panel>
          <SectionTitle>Server storage</SectionTitle>
          <StorageTable rows={storageRows} />
        </Panel>
      ) : null}

      {!["complete", "failed", "cancelled", "interrupted"].includes(job.state) && onCancel ? (
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel job
          </Button>
        </div>
      ) : null}
    </div>
  );
}
