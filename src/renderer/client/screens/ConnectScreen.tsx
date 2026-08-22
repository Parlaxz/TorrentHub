import { useState, type FormEvent } from "react";
import { Button, ErrorText, Field, Panel, Spinner, TextInput } from "../components/ui";
import type { SavedConnection } from "../lib/bridge";

const CODE_RE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;
const HOST_RE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*)$/;

export function validatePairInput(host: string, port: string, code: string): string | null {
  if (!host.trim()) return "Enter the server IP or hostname.";
  if (!HOST_RE.test(host.trim())) return "That doesn't look like a valid IP or hostname.";
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Port must be between 1 and 65535.";
  if (!CODE_RE.test(code.trim())) return "Pairing code must look like XXXX-XXXX.";
  return null;
}

/**
 * Screen 1 — first use / Change Server Address.
 * Secrets never touch localStorage: values go straight through the preload
 * bridge to main, which owns pairing + token storage.
 */
export function ConnectScreen({
  bridge,
  mode,
  saved,
  onPaired,
  onCancel,
}: {
  bridge: NonNullable<import("../lib/bridge").VikingBridge>;
  mode: "initial" | "change";
  saved: SavedConnection | null;
  onPaired: (conn: SavedConnection) => void;
  onCancel?: () => void;
}) {
  const [host, setHost] = useState(saved?.host ?? "");
  const [port, setPort] = useState(String(saved?.port ?? ""));
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const invalid = validatePairInput(host, port, code);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await bridge.pair({ host: host.trim(), port: Number(port), code: code.trim().toUpperCase() });
      if (res.ok) onPaired(res.value);
      else setError(res.error || "Pairing failed. Check the address and code.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-6 py-10">
      <h1 className="text-center text-xl font-black tracking-[0.2em] text-zinc-900 dark:text-zinc-50">
        VIKING RELAY
      </h1>
      <p className="mt-1 mb-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
        {mode === "initial" ? "Connect to your relay server to begin." : "Change server address"}
      </p>

      <Panel>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <Field label="Server IP">
            <TextInput
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="26.x.x.x"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </Field>
          <Field label="Port">
            <TextInput
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="47821"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field label="Pairing Code">
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="font-mono tracking-widest uppercase"
            />
          </Field>

          <ErrorText>{error}</ErrorText>

          <Button type="submit" disabled={busy} className="mt-1 w-full py-2">
            {busy ? <Spinner /> : null}
            {mode === "initial" ? "Pair & Connect" : "Save & Reconnect"}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Back
            </Button>
          ) : null}
        </form>
      </Panel>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-600">
        The pairing code is shown by Viking Relay on the server. Credentials are stored securely by the app —
        never in browser storage.
      </p>
    </div>
  );
}
