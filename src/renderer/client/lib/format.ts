/** Human-readable formatting helpers. Pure, no dependencies. */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const neg = bytes < 0;
  const v = Math.abs(bytes);
  let out: string;
  if (v >= TB) out = `${trim(v / TB)} TB`;
  else if (v >= GB) out = `${trim(v / GB)} GB`;
  else if (v >= MB) out = `${trim(v / MB)} MB`;
  else if (v >= KB) out = `${trim(v / KB)} KB`;
  else out = `${Math.round(v)} B`;
  return neg ? `-${out}` : out;
}

function trim(n: number): string {
  // Up to 1 decimal, no trailing ".0"
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Speeds always shown per second; 0 renders as "0 B/s". */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return "—";
  if (bytesPerSecond < 0) bytesPerSecond = 0;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "6m 08s" style; null/undefined → "—" when not meaningful. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${String(rm).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${String(h % 24).padStart(2, "0")}h`;
}

export function formatPercent(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const clamped = Math.max(0, Math.min(100, pct));
  return `${Math.floor(clamped)}%`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}
