/**
 * Pairing panel — short human code + expiry. Never shows bearer tokens.
 */

import { useEffect } from "react";
import { useRuntime } from "../state/RuntimeContext";
import { useNow } from "../state/useNow";
import { pairingCountdown } from "../domain/derive";
import { Button, Modal } from "../components/ui";

export function PairingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pairing, generatePairing } = useRuntime();
  const now = useNow(250);
  const countdown = pairing ? pairingCountdown(pairing, now) : null;
  // The backend generates a dashless 8-char code; display it grouped for readability.
  const rawCode = pairing ? pairing.code.replace(/[\s-]+/g, "") : "";
  const displayCode = pairing ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : null;

  // Offer a fresh code as soon as the panel opens.
  useEffect(() => {
    if (open && !pairing) void generatePairing();
  }, [open, pairing, generatePairing]);

  return (
    <Modal open={open} onClose={onClose} title="Pair a Client">
      <div className="space-y-4">
        {pairing && countdown && !countdown.expired ? (
          <>
            <p
              className="text-center font-mono text-4xl font-bold tracking-[0.18em] text-zinc-900 dark:text-zinc-50"
              data-testid="pairing-code"
              role="status"
            >
              {displayCode}
            </p>
            <p className="text-center text-sm text-zinc-500 dark:text-zinc-400" data-testid="pairing-countdown" aria-live="polite">
              Expires in{" "}
              <span className={`font-mono font-semibold ${countdown.urgent ? "text-red-600 dark:text-red-400" : ""}`}>
                {countdown.text}
              </span>
            </p>
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-300">
              Enter this code on the Client PC.
            </p>
          </>
        ) : (
          <p role="status" className="text-center text-sm text-zinc-600 dark:text-zinc-300" data-testid="pairing-expired">
            {pairing ? "Code expired — generate a new one." : "No active pairing code."}
          </p>
        )}
        <div className="flex justify-center gap-2">
          <Button variant="primary" onClick={() => void generatePairing()} data-testid="pairing-regenerate">
            Generate new code
          </Button>
        </div>
      </div>
    </Modal>
  );
}
