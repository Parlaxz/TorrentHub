/**
 * Small settings panel. Secrets are write-only: inputs start empty, saving
 * stores them via the bridge, and the UI afterwards shows only a mask.
 */

import { useEffect, useState } from "react";
import type { VikingRelayServerBridge } from "../bridge/types";
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
