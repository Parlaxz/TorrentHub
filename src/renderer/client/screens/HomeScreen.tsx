import { useState, type FormEvent } from "react";
import { Button, ErrorText, Panel, SectionTitle, StatusDot } from "../components/ui";
import type { ConnectionStatus } from "../lib/bridge";

const MAGNET_RE = /^magnet:\?xt=urn:btih:[a-z0-9]{32,}/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function validateIntakeInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste a magnet link or a torrent URL.";
  if (MAGNET_RE.test(v)) return null;
  if (/^magnet:/i.test(v)) return "That magnet link is missing its info hash (xt=urn:btih:…).";
  if (URL_RE.test(v)) return null;
  return "Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file.";
}

/** Screen 2 — Home / submit. */
export function HomeScreen({
  connection,
  onSubmit,
  busy,
  error,
}: {
  connection: ConnectionStatus | null;
  onSubmit: (input: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const invalid = validateIntakeInput(value);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    onSubmit(value.trim());
  };

  const state = connection?.state ?? "offline";

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-8">
      <Panel>
        <SectionTitle>Server</SectionTitle>
        <div className="mb-5 flex items-center gap-2 text-sm">
          <StatusDot state={state} />
          <span
            className={`font-semibold capitalize ${
              state === "connected"
                ? "text-emerald-600 dark:text-emerald-400"
                : state === "reconnecting"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
            }`}
          >
            {state}
          </span>
          {connection?.host ? (
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {connection.host}
              {connection.port ? `:${connection.port}` : ""}
            </span>
          ) : null}
        </div>

        <SectionTitle>Torrent / Magnet</SectionTitle>
        <form onSubmit={submit} noValidate>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…"
            aria-label="Torrent magnet link or URL"
            aria-invalid={Boolean(localError) || undefined}
            spellCheck={false}
            autoComplete="off"
            disabled={busy || state !== "connected"}
            className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-[13px] text-zinc-900 placeholder:text-zinc-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
              localError || error
                ? "border-red-500 focus:ring-red-500/60"
                : "border-zinc-300 focus:border-blue-500 dark:border-zinc-700"
            }`}
          />
          <ErrorText>{localError ?? error}</ErrorText>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-600">Magnet URI or HTTP(S) .torrent URL</p>
            <Button type="submit" disabled={busy || state !== "connected"}>
              Continue
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
