/**
 * Small settings panel. Secrets are write-only: inputs start empty, saving
 * stores them via the bridge, and the UI afterwards shows only a mask.
 */

import { useEffect, useState } from "react";
import type { PairedClientInfo, VikingRelayServerBridge } from "../bridge/types";
import { SECRET_MASK, secretDisplay } from "../domain/secrets";
import { useRuntime } from "../state/RuntimeContext";
import { Button, Modal, TextField, Toggle } from "../components/ui";

export function SettingsPanel({
  open,
  onClose,
  bridge,
}: {
  open: boolean;
  onClose: () => void;
  bridge: VikingRelayServerBridge;
}) {
  const { settings, capabilities, saveSettings } = useRuntime();
  const [folderPath, setFolderPath] = useState("");
  const [relayPort, setRelayPort] = useState("");
  const [qbitUrl, setQbitUrl] = useState("");
  const [qbitKeyInput, setQbitKeyInput] = useState("");
  const [vikingHashInput, setVikingHashInput] = useState("");
  const [pairedClients, setPairedClients] = useState<PairedClientInfo[] | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!open || !bridge.listPairedClients) return;
    let cancelled = false;
    bridge
      .listPairedClients()
      .then((clients) => {
        if (!cancelled) setPairedClients(clients);
      })
      .catch(() => {
        if (!cancelled) setPairedClients([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, bridge]);

  const disconnectClient = async (clientId: string): Promise<void> => {
    if (!bridge.revokePairedClient) return;
    await bridge.revokePairedClient(clientId);
    if (bridge.listPairedClients) setPairedClients(await bridge.listPairedClients());
  };

  const resetProfile = async (): Promise<void> => {
    if (!bridge.resetProfile) return;
    const confirmed = window.confirm(
      "Reset the server profile? This stops the server, disconnects every paired client, and erases all settings and saved keys. Downloaded files and history stay on disk.",
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await bridge.resetProfile();
      window.location.reload();
    } finally {
      setResetting(false);
    }
  };

  useEffect(() => {
    if (!settings) return;
    setFolderPath(settings.workingFolderPath ?? "");
    setRelayPort(String(settings.relayPort));
    setQbitUrl(settings.qbitWebUiUrl);
  }, [settings]);

  if (!settings || !capabilities) return null;

  const qbitKeyDisplay = secretDisplay(settings.qbitApiKeySet);
  const vikingHashDisplay = secretDisplay(settings.vikingUserHashSet);

  const applyGeneral = async () => {
    await saveSettings({
      workingFolderPath: folderPath.trim() || null,
      relayPort: Number.parseInt(relayPort, 10) || settings.relayPort,
      qbitWebUiUrl: qbitUrl,
    });
  };

  const saveQbitKey = async () => {
    if (qbitKeyInput.length === 0) return;
    await bridge.setQbitApiKey(qbitKeyInput);
    setQbitKeyInput("");
    await saveSettings({});
  };

  const saveVikingHash = async () => {
    if (!bridge.setVikingUserHashSetting) return;
    await bridge.setVikingUserHashSetting(vikingHashInput);
    setVikingHashInput("");
    await saveSettings({});
  };

  return (
    <Modal open={open} onClose={onClose} title="Settings" wide>
      <div className="space-y-5">
        <TextField
          id="settings-folder"
          label="Working folder"
          value={folderPath}
          onChange={(event) => setFolderPath(event.target.value)}
          hint="Temporary torrent downloads and ZIP files are stored here."
        />

        <TextField
          id="settings-port"
          label="Relay port"
          type="number"
          value={relayPort}
          onChange={(event) => setRelayPort(event.target.value)}
          hint="Clients reach this server at your Radmin IPv4 address on this port."
        />

        <TextField
          id="settings-qbit-url"
          label="qBittorrent WebUI URL"
          value={qbitUrl}
          onChange={(event) => setQbitUrl(event.target.value)}
        />

        <div>
          <TextField
            id="settings-qbit-key"
            label="qBittorrent API key"
            type="password"
            autoComplete="off"
            value={qbitKeyInput}
            onChange={(event) => setQbitKeyInput(event.target.value)}
            placeholder={qbitKeyDisplay.state === "saved" ? SECRET_MASK : ""}
            data-testid="settings-qbit-key"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <Button disabled={qbitKeyInput.length === 0} onClick={() => void saveQbitKey()} data-testid="save-qbit-key">
              Save key
            </Button>
            {qbitKeyDisplay.state === "saved" ? (
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400" data-testid="qbit-key-saved-indicator">
                Saved ✓
              </span>
            ) : null}
          </div>
        </div>

        {bridge.setVikingUserHashSetting ? (
          <div>
            <TextField
              id="settings-viking-hash"
              label="Viking user hash"
              type="password"
              autoComplete="off"
              value={vikingHashInput}
              onChange={(event) => setVikingHashInput(event.target.value)}
              placeholder={vikingHashDisplay.state === "saved" ? SECRET_MASK : ""}
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Button disabled={vikingHashInput.length === 0} onClick={() => void saveVikingHash()}>
                Save hash
              </Button>
              {vikingHashDisplay.state === "saved" ? (
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved ✓</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <hr className="border-zinc-100 dark:border-zinc-800" />

        <Toggle
          label="Start server with Windows"
          description={
            capabilities.startWithWindows
              ? "Launches Viking Relay in the tray when you sign in."
              : "Not available in this build."
          }
          checked={capabilities.startWithWindows ? settings.startWithWindows : false}
          disabled={!capabilities.startWithWindows}
          onChange={(next) => void saveSettings({ startWithWindows: next })}
        />
        <Toggle
          label="Prevent sleep during transfers"
          description="Keeps this machine awake while a job is running."
          checked={settings.preventSleepDuringTransfers}
          onChange={(next) => void saveSettings({ preventSleepDuringTransfers: next })}
        />

        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Mode: Server. Switch to Client mode from the tray menu.
        </p>

        {bridge.listPairedClients ? (
          <div data-testid="paired-clients-section">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Paired clients
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Paired PCs stay connected until you disconnect them here.
            </p>
            {pairedClients === null ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Loading…</p>
            ) : pairedClients.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400" data-testid="no-paired-clients">
                No clients paired yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {pairedClients.map((client) => (
                  <li
                    key={client.clientId}
                    className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">
                        {client.name}
                      </span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        Paired {new Date(client.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <Button variant="ghost" onClick={() => void disconnectClient(client.clientId)}>
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <hr className="border-zinc-100 dark:border-zinc-800" />

        <div className="rounded-md border border-red-200 p-3 dark:border-red-900/60" data-testid="danger-zone">
          <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">Danger zone</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Erases all settings, saved keys, and pairings, then restarts first-time setup.
          </p>
          {bridge.resetProfile ? (
            <Button
              variant="ghost"
              disabled={resetting}
              onClick={() => void resetProfile()}
              className="mt-2 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              data-testid="reset-profile"
            >
              Reset server profile…
            </Button>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void applyGeneral()} data-testid="settings-save">
            Save settings
          </Button>
        </div>
      </div>
    </Modal>
  );
}
