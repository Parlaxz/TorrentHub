import os from "node:os";

export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type InterfaceMap = Record<string, InterfaceAddress[]>;

export type EnumerateInterfaces = () => InterfaceMap;

export interface AdapterCandidate {
  adapterName: string;
  address: string;
}

export type SelectionReason =
  | "override"
  | "adapter_name_match"
  | "preferred_name"
  | "single_candidate"
  | "ambiguous"
  | "override_not_found"
  | "none";

export interface AdapterSelection {
  selected: AdapterCandidate | null;
  candidates: AdapterCandidate[];
  reason: SelectionReason;
}

export interface SelectionConfig {
  overrideAddress?: string | null;
  preferredAdapterNames?: string[];
  allowUnmatchedSingleAdapter?: boolean;
}

export const DEFAULT_RADMIN_ADAPTER_PATTERN = /radmin|famatech/i;

const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function defaultEnumerateInterfaces(): InterfaceMap {
  return os.networkInterfaces() as InterfaceMap;
}

function familyIsV4(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

export function isBindableIpv4(addr: InterfaceAddress): boolean {
  return (
    !addr.internal &&
    familyIsV4(addr.family) &&
    typeof addr.address === "string" &&
    IPV4_RE.test(addr.address) &&
    addr.address !== "0.0.0.0"
  );
}

export function collectIpv4Candidates(map: InterfaceMap): AdapterCandidate[] {
  const out: AdapterCandidate[] = [];
  for (const [adapterName, addrs] of Object.entries(map)) {
    for (const addr of addrs ?? []) {
      if (isBindableIpv4(addr)) out.push({ adapterName, address: addr.address });
    }
  }
  out.sort(
    (a, b) => a.adapterName.localeCompare(b.adapterName) || a.address.localeCompare(b.address),
  );
  return out;
}

function nameMatches(
  adapterName: string,
  cfg: SelectionConfig,
): "radmin" | "preferred" | null {
  if (DEFAULT_RADMIN_ADAPTER_PATTERN.test(adapterName)) return "radmin";
  for (const pref of cfg.preferredAdapterNames ?? []) {
    if (pref && adapterName.toLowerCase().includes(pref.toLowerCase())) return "preferred";
  }
  return null;
}

export function selectAdapter(
  map: InterfaceMap,
  cfg: SelectionConfig = {},
): AdapterSelection {
  const candidates = collectIpv4Candidates(map);

  if (cfg.overrideAddress) {
    const hit = candidates.find((c) => c.address === cfg.overrideAddress);
    if (!hit) return { selected: null, candidates, reason: "override_not_found" };
    return { selected: hit, candidates, reason: "override" };
  }

  for (const candidate of candidates) {
    const match = nameMatches(candidate.adapterName, cfg);
    if (match === "radmin") {
      return { selected: candidate, candidates, reason: "adapter_name_match" };
    }
    if (match === "preferred") {
      return { selected: candidate, candidates, reason: "preferred_name" };
    }
  }

  if (cfg.allowUnmatchedSingleAdapter && candidates.length === 1) {
    return { selected: candidates[0], candidates, reason: "single_candidate" };
  }

  return {
    selected: null,
    candidates,
    reason: candidates.length === 0 ? "none" : "ambiguous",
  };
}
