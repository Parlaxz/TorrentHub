import { useEffect, useRef, useState } from "react";

/**
 * Fixed-cadence polling with graceful reconnect semantics.
 *
 * Contract (A7):
 *  - polls roughly once per `intervalMs` (next attempt scheduled after the
 *    previous settles — never overlapping)
 *  - a FAILED POLL NEVER CANCELS SERVER-SIDE WORK: it only flips status to
 *    "reconnecting"; the next successful poll renders authoritative state
 *  - bounded lifecycle: stops when `enabled` goes false or on unmount,
 *    clearing pending timers and ignoring in-flight results
 */
export type PollStatus = "idle" | "live" | "reconnecting";

export interface UsePollingOptions<T> {
  fn: () => Promise<T>;
  enabled: boolean;
  intervalMs?: number;
  onData: (data: T) => void;
  onError?: (err: unknown) => void;
}

export function usePolling<T>(opts: UsePollingOptions<T>): PollStatus {
  const { enabled, intervalMs = 1000 } = opts;
  const [status, setStatus] = useState<PollStatus>(enabled ? "reconnecting" : "idle");

  const fnRef = useRef(opts.fn);
  const dataRef = useRef(opts.onData);
  const errRef = useRef(opts.onError);
  fnRef.current = opts.fn;
  dataRef.current = opts.onData;
  errRef.current = opts.onError;

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const setStatusIfChanged = (s: PollStatus): void => {
      setStatus((prev) => (prev === s ? prev : s));
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const data = await fnRef.current();
        if (cancelled) return;
        setStatusIfChanged("live");
        dataRef.current(data);
      } catch (err) {
        if (cancelled) return;
        // Transient failure: surface reconnecting, keep the loop alive.
        setStatusIfChanged("reconnecting");
        errRef.current?.(err);
      }
      if (cancelled) return;
      timer = setTimeout(() => void tick(), intervalMs);
    };

    setStatus("reconnecting");
    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);

  return status;
}
