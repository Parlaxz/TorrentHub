/** Send a magnet/link to a paired client's local download queue ("friend mode"). */

import { useEffect, useState } from "react";
import type { PairedClientInfo, SentDirectJob, VikingRelayServerBridge } from "../bridge/types";
import { Button, Modal, TextField } from "../components/ui";

const STATE_LABEL: Record<SentDirectJob["state"], string> = {
  queued: "Queued on friend",
  accepted: "Accepted",
  declined: "Declined",
};

export function SendDirectModal({
  open,
  onClose,
  bridge,
}: {
  open: boolean;
  onClose: () => void;
  bridge: VikingRelayServerBridge;
}) {
  const [clients, setClients] = useState<PairedClientInfo[]>([]);
  const [target, setTarget] = useState("");
  const [source, setSource] = useState("");
  const [sent, setSent] = useState<SentDirectJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = bridge.listPairedClients ? await bridge.listPairedClients() : [];
        if (!cancelled) {
          setClients(list);
          setTarget((t) => t || list[0]?.clientId || "");
        }
        if (bridge.listDirectJobs) {
          const jobs = await bridge.listDirectJobs();
          if (!cancelled) setSent(jobs);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, bridge]);

  const send = async (): Promise<void> => {
    if (!bridge.sendDirectJob || !target) return;
    setError(null);
    setBusy(true);
    try {
      const res = await bridge.sendDirectJob(source.trim(), target);
      if (!res.ok) {
        setError(res.error ?? "Could not send.");
      } else {
        setSource("");
        setSent(bridge.listDirectJobs ? await bridge.listDirectJobs() : null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Send to friend" wide>
      <div className="space-y-4">
        {clients.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No paired clients yet. Pair your friend's PC first.
          </p>
        ) : (
          <>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Friend
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                data-testid="send-target"
              >
                {clients.map((c) => (
                  <option key={c.clientId} value={c.clientId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <TextField
              id="send-direct-source"
              label="Magnet or link"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="magnet:?xt=… or https://…"
              hint="Their app downloads it locally — no ZIP, no upload."
            />

            {error ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400" data-testid="send-error">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end">
              <Button variant="primary" disabled={busy || source.trim().length === 0} onClick={() => void send()} data-testid="send-direct">
                Send
              </Button>
            </div>

            {sent && sent.length > 0 ? (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Sent
                </h3>
                <ul className="mt-1 space-y-1 text-xs" data-testid="sent-list">
                  {sent.map((j) => (
                    <li key={j.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{j.source}</span>
                      <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
                        → {j.targetName} · {STATE_LABEL[j.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
