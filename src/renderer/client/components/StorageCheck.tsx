import { StorageTable, type StorageRow } from "./StorageTable";
import { Badge, Panel, SectionTitle } from "./ui";
import { startBlocked, storageVerdict } from "../lib/preflight";
import type { StoragePreflight } from "../types";

/** Server-authoritative storage verdict, rendered verbatim. */
export function StorageCheck({ preflight }: { preflight: StoragePreflight | null }) {
  if (!preflight) return null;
  const verdict = storageVerdict(preflight);
  const rows: StorageRow[] = [
    { label: "Selected files", bytes: preflight.selectedBytes },
    ...(preflight.tempZipBytes != null
      ? [{ label: "Temporary ZIP", bytes: preflight.tempZipBytes }]
      : []),
    { label: "Safety reserve", bytes: preflight.safetyReserveBytes },
    { label: "Peak required", bytes: preflight.peakRequiredBytes, strong: true },
    { label: "Server free", bytes: preflight.serverFreeBytes },
  ];
  const blocked = startBlocked(preflight);
  return (
    <Panel>
      <SectionTitle
        right={
          <Badge tone={verdict.ok && !blocked ? "green" : "red"}>
            {verdict.ok && !blocked ? "✓ Enough storage" : "⚠ Blocked"}
          </Badge>
        }
      >
        Storage check
      </SectionTitle>
      <StorageTable rows={rows} />
      {!verdict.ok || blocked ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700 dark:text-red-400">
          ⚠ {verdict.text}
        </p>
      ) : null}
    </Panel>
  );
}
