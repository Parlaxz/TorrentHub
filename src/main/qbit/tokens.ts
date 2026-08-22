/**
 * Locally-minted intake tokens.
 *
 * The qBittorrent WebAPI provides NO server-side intake/metadata token
 * (verified: fetchMetadata returns data directly; nothing token-shaped exists),
 * so Viking Relay mints deterministic tokens embedding the canonical torrent
 * hash: `vr_intake_<hash>`.
 */

import type { IntakeToken } from './types';

const PREFIX = 'vr_intake_';

export function mintIntakeToken(infoHash: string): IntakeToken {
  return `${PREFIX}${infoHash.toLowerCase()}` as IntakeToken;
}

/** Extracts the embedded hash, or null when the token is malformed. */
export function hashFromToken(token: string): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  return /^[a-f0-9]{16,64}$/i.test(rest) ? rest.toLowerCase() : null;
}
