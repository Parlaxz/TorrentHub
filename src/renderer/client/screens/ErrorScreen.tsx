import { Button, Panel } from "../components/ui";
import { presentError, type ClientErrorKind } from "../lib/errors";

/** Screen 9 — specific, actionable error states. */
export function ErrorScreen({
  kind,
  message,
  onRetryPackaging,
  onRetryUpload,
  onBack,
}: {
  kind: ClientErrorKind;
  message?: string | null;
  onRetryPackaging?: () => void;
  onRetryUpload?: () => void;
  onBack: () => void;
}) {
  const p = presentError(kind, message);
  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-10">
      <Panel>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${
              kind === "cancelled" || kind === "interrupted" ? "bg-zinc-400 dark:bg-zinc-600" : "bg-red-600"
            }`}
          >
            {kind === "cancelled" ? "⊘" : "!"}
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{p.title}</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">{p.detail}</p>
            {message && message !== p.detail ? (
              <p className="mt-2 rounded bg-zinc-100 px-2 py-1.5 font-mono text-[11px] leading-snug text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {message}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {p.retry === "packaging" && onRetryPackaging ? (
            <Button variant="secondary" onClick={onRetryPackaging}>
              Retry Packaging
            </Button>
          ) : null}
          {p.retry === "upload" && onRetryUpload ? (
            <Button variant="secondary" onClick={onRetryUpload}>
              Retry Upload
            </Button>
          ) : null}
          <Button onClick={onBack}>{kind === "interrupted" ? "Start a new torrent" : "Back"}</Button>
        </div>
      </Panel>
    </div>
  );
}
