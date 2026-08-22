/** Specific, human qBittorrent probe error copy. Pure. */

import type { QbitProbeResult } from "../bridge/types";

export function qbitErrorText(result: QbitProbeResult): string {
  switch (result.reason) {
    case "not_running":
      return "qBittorrent isn't running. Start it and try again.";
    case "auth":
      return "Wrong API key or credentials.";
    case "version_too_old":
      return "This qBittorrent version is too old. Viking Relay needs 5.2 or newer.";
    case "invalid_url":
      return "That Web API address doesn't look valid. Example: http://127.0.0.1:8080";
    default:
      return result.message || "Could not reach qBittorrent.";
  }
}
