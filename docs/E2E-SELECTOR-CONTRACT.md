# E2E Selector Contract

Priority: `data-testid` → accessible role/name → stable semantic attribute → structure (last resort).
No decorative testids. Every mapping below is product-semantic.

## Existing product testids (verified in source)

| Selector | Purpose |
|---|---|
| `global-settings-button` | header ⚙ settings |
| `global-settings-modal`, `global-updates-section`, `global-update-status`, `global-check-updates`, `global-install-update` | global settings modal |
| `startup-section`, `start-with-windows`, `minimize-to-tray` | behavior toggles |
| `direct-downloads-section`, `dd-auto-accept`, `dd-qbit-url`, `dd-qbit-key`, `dd-download-dir`, `dd-save`, `dd-refresh`, `dd-empty`, `dd-queue`, `dd-item-<id>`, `dd-accept-<id>`, `dd-decline-<id>` | client receiver inbox |
| `open-logs-folder` | logs folder button |
| `add-friend`, `add-friend-confirm`, `friend-<clientId>` | client friends |
| `open-page-link`, `open-direct-link` | CompleteScreen external opens |
| `pair-client`, `send-to-friend`, `open-settings`, `exit-button`, `exit-cancel`, `exit-confirm` | server dashboard |
| `pairing-regenerate` | pairing modal |
| `send-direct` | SendDirectModal send |
| `save-qbit-key`, `settings-save`, `install-update` | SettingsPanel |
| `active-transfer` | ActiveTransferCard |
| `online-line` | Dashboard header online/offline line (contains address — never exact-match "Online") |
| `offline-banner` / `interrupted-banner` | dashboard banners |
| `cleanup-deleteTorrent` / `cleanup-deleteFiles` / `cleanup-deleteZip` | SelectionScreen cleanup checkboxes (camelCase keys; NOTE: rendered only after preflight verdict) |
| `cleanup-delete-torrent` / `cleanup-delete-files` / `cleanup-delete-zip` | SettingsPanel auto-delete switches (kebab-case; on the `role=switch` buttons) |
| `server-address` | Radmin step address readout |
| `qbit-probe-ok` / `qbit-probe-error` | qBittorrent step probe result |
| `ready-<label>` / `start-server` / `next-step` | wizard ready checklist + controls |

## Corrections discovered during the campaign

- The server StagePipeline uses aria-label **"Job stages"** (client) vs **"Transfer stages"**
  (ActiveTransferCard) — both valid; scope locators per surface.
- Client Home status text renders lowercase (`connected`) with CSS `capitalize` — match
  case-insensitively.

## Accessible-name conventions used by specs

| Control | Locator |
|---|---|
| Connect form fields | label text `Server IP` / `Port` / `Pairing Code` |
| Pair submit | role button `/Pair & Connect/` (initial) or `/Save & Reconnect/` (change) |
| Mode chooser | role button `/Client PC/`, `/Server PC/` |
| Header switch | role button `Switch mode` |
| File filter | aria-label `Filter files` |
| Tree expand/collapse | aria-label `/Expand <name>/`, `/Collapse <name>/` |
| Telemetry | aria-label `speed`, `eta` |
| Stage pipeline | aria-label `Transfer stages` |
| Modal close | aria-label `Close dialog` / `Close settings` |

## Rules for adding new testids

1. Only when no role/name locator is stable for an important surface.
2. Prefix by domain (`job-`, `hist-`, `setup-`).
3. Add the mapping here in the same change.
